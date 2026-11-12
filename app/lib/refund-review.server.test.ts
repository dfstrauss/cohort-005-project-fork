import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import {
  approveRefundRequest,
  declineRefundRequest,
  getRefundReviewQueue,
  markRefundFailed,
  markRefundIssued,
  retryRefund,
} from "./refund-review.server";

type TestDb = ReturnType<typeof createTestDb>;

const PURCHASED_AT = new Date(2026, 10, 1, 23, 0); // 1 Nov, 23:00 local
const REVIEWED_AT = new Date(2026, 10, 10, 9, 0); // 10 Nov — 5 days left

function setup(testDb: TestDb) {
  const base = seedBaseData(testDb);

  const admin = testDb
    .insert(schema.users)
    .values({
      name: "Ada Admin",
      email: "ada@example.com",
      role: schema.UserRole.Admin,
    })
    .returning()
    .get();

  const otherAdmin = testDb
    .insert(schema.users)
    .values({
      name: "Otto Admin",
      email: "otto@example.com",
      role: schema.UserRole.Admin,
    })
    .returning()
    .get();

  const mod = testDb
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();

  const lessonIds = [1, 2, 3, 4].map(
    (position) =>
      testDb
        .insert(schema.lessons)
        .values({ moduleId: mod.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );

  const purchase = testDb
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid: 7900,
      createdAt: PURCHASED_AT.toISOString(),
    })
    .returning()
    .get();

  testDb
    .insert(schema.enrollments)
    .values({ userId: base.user.id, courseId: base.course.id })
    .run();

  testDb
    .insert(schema.lessonProgress)
    .values([
      {
        userId: base.user.id,
        lessonId: lessonIds[0],
        status: schema.LessonProgressStatus.Completed,
      },
      {
        userId: base.user.id,
        lessonId: lessonIds[1],
        status: schema.LessonProgressStatus.InProgress,
      },
    ])
    .run();

  testDb
    .insert(schema.videoWatchEvents)
    .values([
      // Only the furthest position per lesson counts.
      {
        userId: base.user.id,
        lessonId: lessonIds[0],
        eventType: "heartbeat",
        positionSeconds: 100,
      },
      {
        userId: base.user.id,
        lessonId: lessonIds[0],
        eventType: "heartbeat",
        positionSeconds: 300,
      },
      {
        userId: base.user.id,
        lessonId: lessonIds[1],
        eventType: "heartbeat",
        positionSeconds: 60,
      },
    ])
    .run();

  const request = testDb
    .insert(schema.refunds)
    .values({
      purchaseId: purchase.id,
      reason: "Bought the wrong one, I meant the advanced course.",
    })
    .returning()
    .get();

  return { ...base, admin, otherAdmin, lessonIds, purchase, request };
}

function getRequest(testDb: TestDb, id: number) {
  return testDb
    .select()
    .from(schema.refunds)
    .where(eq(schema.refunds.id, id))
    .get()!;
}

function isEnrolled(testDb: TestDb, userId: number, courseId: number) {
  return !!testDb
    .select()
    .from(schema.enrollments)
    .where(
      and(
        eq(schema.enrollments.userId, userId),
        eq(schema.enrollments.courseId, courseId)
      )
    )
    .get();
}

describe("refund request review", () => {
  let testDb: TestDb;
  let s: ReturnType<typeof setup>;

  beforeEach(() => {
    testDb = createTestDb();
    s = setup(testDb);
  });

  describe("the queue", () => {
    it("shows each Open Refund Request with the evidence to decide it", () => {
      const { needsDecision, moneyToSend } = getRefundReviewQueue(
        testDb,
        REVIEWED_AT
      );

      expect(moneyToSend).toEqual([]);
      expect(needsDecision).toHaveLength(1);
      expect(needsDecision[0]).toMatchObject({
        id: s.request.id,
        learnerName: "Test User",
        learnerEmail: "test@example.com",
        courseTitle: "Test Course",
        amountPaid: 7900,
        reason: "Bought the wrong one, I meant the advanced course.",
        windowLastDay: "2026-11-15",
        daysLeftInWindow: 5,
        secondsWatched: 360,
        overWatchLimit: false,
        lessonProgress: { completed: 1, inProgress: 1, total: 4 },
        earlierDeclined: [],
      });
    });

    it("warns when the window has closed while the request was open", () => {
      const { needsDecision } = getRefundReviewQueue(
        testDb,
        new Date(2026, 10, 17, 9, 0)
      );

      expect(needsDecision[0].daysLeftInWindow).toBe(-2);
    });

    it("warns when the learner kept watching past the cap", () => {
      testDb
        .insert(schema.videoWatchEvents)
        .values({
          userId: s.user.id,
          lessonId: s.lessonIds[2],
          eventType: "heartbeat",
          positionSeconds: 2 * 60 * 60,
        })
        .run();

      const { needsDecision } = getRefundReviewQueue(testDb, REVIEWED_AT);

      expect(needsDecision[0].overWatchLimit).toBe(true);
    });

    it("shows earlier Declined Refund Requests on the same purchase", () => {
      declineRefundRequest(
        testDb,
        s.request.id,
        s.admin.id,
        "You've finished most of the course."
      );
      testDb
        .insert(schema.refunds)
        .values({ purchaseId: s.purchase.id, reason: "Please reconsider." })
        .run();

      const { needsDecision } = getRefundReviewQueue(testDb, REVIEWED_AT);

      expect(needsDecision).toHaveLength(1);
      expect(needsDecision[0].reason).toBe("Please reconsider.");
      expect(needsDecision[0].earlierDeclined).toMatchObject([
        {
          reason: "Bought the wrong one, I meant the advanced course.",
          declineReason: "You've finished most of the course.",
        },
      ]);
    });
  });

  describe("approving", () => {
    it("creates a Pending Refund for the full amount and ends access", () => {
      const result = approveRefundRequest(
        testDb,
        s.request.id,
        s.admin.id,
        REVIEWED_AT
      );

      expect(result.ok).toBe(true);
      expect(getRequest(testDb, s.request.id)).toMatchObject({
        status: schema.RefundStatus.Approved,
        moneyStatus: schema.RefundMoneyStatus.Pending,
        amountRefunded: 7900,
        resolvedByUserId: s.admin.id,
        resolvedAt: REVIEWED_AT.toISOString(),
      });
      expect(isEnrolled(testDb, s.user.id, s.course.id)).toBe(false);
    });

    it("emails the learner that the money is coming and access has ended", () => {
      const result = approveRefundRequest(testDb, s.request.id, s.admin.id);

      if (!result.ok) throw new Error(result.error);
      expect(result.email.to).toBe("test@example.com");
      expect(result.email.subject).toBe("Refund approved — Test Course");
      expect(result.email.body).toContain("$79.00");
      expect(result.email.body).toContain("access");
    });

    it("moves the request from needing a decision to money to send", () => {
      approveRefundRequest(testDb, s.request.id, s.admin.id);

      const { needsDecision, moneyToSend } = getRefundReviewQueue(testDb);

      expect(needsDecision).toEqual([]);
      expect(moneyToSend).toMatchObject([
        {
          id: s.request.id,
          moneyStatus: schema.RefundMoneyStatus.Pending,
          amountRefunded: 7900,
          approvedByName: "Ada Admin",
        },
      ]);
    });

    it("is final: a second Admin acting on it changes nothing", () => {
      approveRefundRequest(testDb, s.request.id, s.admin.id);
      const before = getRequest(testDb, s.request.id);

      const second = approveRefundRequest(testDb, s.request.id, s.otherAdmin.id);
      const decline = declineRefundRequest(
        testDb,
        s.request.id,
        s.otherAdmin.id,
        "Too late."
      );

      expect(second).toEqual({
        ok: false,
        error: "This Refund Request was already approved by Ada Admin.",
      });
      expect(decline.ok).toBe(false);
      expect(getRequest(testDb, s.request.id)).toEqual(before);
    });
  });

  describe("declining", () => {
    it("needs a reason", () => {
      const result = declineRefundRequest(testDb, s.request.id, s.admin.id, "  ");

      expect(result.ok).toBe(false);
      expect(getRequest(testDb, s.request.id).status).toBe(
        schema.RefundStatus.Open
      );
    });

    it("records the reason, keeps access, and creates no Refund", () => {
      const result = declineRefundRequest(
        testDb,
        s.request.id,
        s.admin.id,
        "You've finished most of the course.",
        REVIEWED_AT
      );

      expect(result.ok).toBe(true);
      expect(getRequest(testDb, s.request.id)).toMatchObject({
        status: schema.RefundStatus.Declined,
        declineReason: "You've finished most of the course.",
        moneyStatus: null,
        amountRefunded: null,
        resolvedByUserId: s.admin.id,
      });
      expect(isEnrolled(testDb, s.user.id, s.course.id)).toBe(true);
    });

    it("tells the learner why", () => {
      const result = declineRefundRequest(
        testDb,
        s.request.id,
        s.admin.id,
        "You've finished most of the course."
      );

      if (!result.ok) throw new Error(result.error);
      expect(result.email.to).toBe("test@example.com");
      expect(result.email.body).toContain("You've finished most of the course.");
    });
  });

  describe("the money", () => {
    beforeEach(() => {
      approveRefundRequest(testDb, s.request.id, s.admin.id);
    });

    it("marks a Pending Refund issued and emails the learner", () => {
      const result = markRefundIssued(testDb, s.request.id, REVIEWED_AT);

      if (!result.ok) throw new Error(result.error);
      expect(result.email?.subject).toBe("Refund sent — Test Course");
      expect(result.email?.body).toContain("$79.00");
      expect(getRequest(testDb, s.request.id)).toMatchObject({
        moneyStatus: schema.RefundMoneyStatus.Issued,
        issuedAt: REVIEWED_AT.toISOString(),
      });
      expect(getRefundReviewQueue(testDb).moneyToSend).toEqual([]);
    });

    it("marks a Refund failed without emailing, and it stays in the queue", () => {
      const result = markRefundFailed(testDb, s.request.id);

      expect(result).toMatchObject({ ok: true, email: null });
      expect(getRequest(testDb, s.request.id)).toMatchObject({
        status: schema.RefundStatus.Approved,
        moneyStatus: schema.RefundMoneyStatus.Failed,
      });
      expect(getRefundReviewQueue(testDb).moneyToSend).toMatchObject([
        { id: s.request.id, moneyStatus: schema.RefundMoneyStatus.Failed },
      ]);
    });

    it("lets a Failed Refund be retried and issued", () => {
      markRefundFailed(testDb, s.request.id);

      const result = markRefundIssued(testDb, s.request.id);

      expect(result.ok).toBe(true);
      expect(getRequest(testDb, s.request.id).moneyStatus).toBe(
        schema.RefundMoneyStatus.Issued
      );
    });

    it("puts a Failed Refund back to Pending on retry, so it can fail again", () => {
      markRefundFailed(testDb, s.request.id);

      const retry = retryRefund(testDb, s.request.id);

      expect(retry).toMatchObject({ ok: true, email: null });
      expect(getRequest(testDb, s.request.id).moneyStatus).toBe(
        schema.RefundMoneyStatus.Pending
      );
      expect(markRefundFailed(testDb, s.request.id).ok).toBe(true);
      expect(getRequest(testDb, s.request.id).moneyStatus).toBe(
        schema.RefundMoneyStatus.Failed
      );
    });

    it("only retries a Failed Refund", () => {
      expect(retryRefund(testDb, s.request.id)).toEqual({
        ok: false,
        error: "This Refund is pending, not failed.",
      });
    });

    it("won't change an Issued Refund", () => {
      markRefundIssued(testDb, s.request.id);

      expect(markRefundFailed(testDb, s.request.id)).toEqual({
        ok: false,
        error: "This Refund is already issued.",
      });
      expect(markRefundIssued(testDb, s.request.id).ok).toBe(false);
      expect(retryRefund(testDb, s.request.id).ok).toBe(false);
    });
  });

  it("won't mark money on a request that hasn't been approved", () => {
    expect(markRefundIssued(testDb, s.request.id)).toEqual({
      ok: false,
      error: "This Refund Request hasn't been approved.",
    });
    expect(markRefundFailed(testDb, s.request.id).ok).toBe(false);
  });
});
