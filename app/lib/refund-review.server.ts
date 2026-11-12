import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { db as appDb } from "~/db";
import {
  courses,
  enrollments,
  lessonProgress,
  lessons,
  LessonProgressStatus,
  modules,
  purchases,
  RefundMoneyStatus,
  RefundStatus,
  refunds,
  users,
  videoWatchEvents,
} from "~/db/schema";
import { formatPrice } from "~/lib/utils";

// ─── Refund Request review ───
// What an Admin needs to decide Refund Requests, and what deciding does.
// Every function takes the database first so tests can hand in an in-memory one.

type Database = typeof appDb;

export const REFUND_WINDOW_DAYS = 14;
export const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;

export type RefundEmail = { to: string; subject: string; body: string };

export type DecisionResult =
  | { ok: true; message: string; email: RefundEmail }
  | { ok: false; error: string };

export type MoneyResult =
  | { ok: true; message: string; email: RefundEmail | null }
  | { ok: false; error: string };

// ─── Calendar days ───
// The window is counted in whole local days, matching how a learner raises a
// request: someone who buys at 23:00 still gets the whole fourteenth day.

function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

function lastDayOfWindow(purchasedAtIso: string): string {
  const deadline = new Date(purchasedAtIso);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(deadline);
}

function daysBetween(fromDay: string, toDay: string): number {
  const from = Date.parse(`${fromDay}T00:00:00Z`);
  const to = Date.parse(`${toDay}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

// ─── Evidence ───

function getLessonIdsForCourse(database: Database, courseId: number) {
  return database
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

function getSecondsWatched(
  database: Database,
  userId: number,
  lessonIds: number[]
) {
  if (lessonIds.length === 0) return 0;

  return database
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all()
    .reduce((total, row) => total + row.furthest, 0);
}

function getLessonProgressCounts(
  database: Database,
  userId: number,
  lessonIds: number[]
) {
  if (lessonIds.length === 0) {
    return { completed: 0, inProgress: 0, total: 0 };
  }

  const rows = database
    .select({ status: lessonProgress.status })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .all();

  return {
    completed: rows.filter((r) => r.status === LessonProgressStatus.Completed)
      .length,
    inProgress: rows.filter(
      (r) => r.status === LessonProgressStatus.InProgress
    ).length,
    total: lessonIds.length,
  };
}

function getEarlierDeclinedRequests(database: Database, purchaseId: number) {
  return database
    .select({
      id: refunds.id,
      reason: refunds.reason,
      declineReason: refunds.declineReason,
      requestedAt: refunds.requestedAt,
      resolvedAt: refunds.resolvedAt,
    })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        eq(refunds.status, RefundStatus.Declined)
      )
    )
    .orderBy(asc(refunds.requestedAt))
    .all();
}

// ─── The queue ───

export function getRefundReviewQueue(database: Database, now = new Date()) {
  const today = calendarDay(now);

  const openRequests = database
    .select({
      id: refunds.id,
      reason: refunds.reason,
      requestedAt: refunds.requestedAt,
      purchaseId: purchases.id,
      amountPaid: purchases.amountPaid,
      purchasedAt: purchases.createdAt,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.status, RefundStatus.Open))
    .orderBy(asc(refunds.requestedAt))
    .all();

  const needsDecision = openRequests.map((request) => {
    const lessonIds = getLessonIdsForCourse(database, request.courseId);
    const windowLastDay = lastDayOfWindow(request.purchasedAt);
    const secondsWatched = getSecondsWatched(
      database,
      request.learnerId,
      lessonIds
    );

    return {
      ...request,
      windowLastDay,
      // Negative once the window has closed: -2 means "closed 2 days ago".
      daysLeftInWindow: daysBetween(today, windowLastDay),
      secondsWatched,
      watchLimitSeconds: REFUND_WATCH_LIMIT_SECONDS,
      // The learner was eligible when they asked, so going over the cap now
      // means they kept watching while the request was open.
      overWatchLimit: secondsWatched >= REFUND_WATCH_LIMIT_SECONDS,
      lessonProgress: getLessonProgressCounts(
        database,
        request.learnerId,
        lessonIds
      ),
      earlierDeclined: getEarlierDeclinedRequests(database, request.purchaseId),
    };
  });

  const approver = alias(users, "approver");

  const moneyToSend = database
    .select({
      id: refunds.id,
      moneyStatus: refunds.moneyStatus,
      amountRefunded: refunds.amountRefunded,
      approvedAt: refunds.resolvedAt,
      approvedByName: approver.name,
      learnerName: users.name,
      learnerEmail: users.email,
      courseTitle: courses.title,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .leftJoin(approver, eq(refunds.resolvedByUserId, approver.id))
    .where(
      and(
        eq(refunds.status, RefundStatus.Approved),
        inArray(refunds.moneyStatus, [
          RefundMoneyStatus.Pending,
          RefundMoneyStatus.Failed,
        ])
      )
    )
    .orderBy(asc(refunds.resolvedAt))
    .all();

  return { needsDecision, moneyToSend };
}

// ─── Deciding ───

function getRequestWithParties(database: Database, refundRequestId: number) {
  return database
    .select({
      id: refunds.id,
      status: refunds.status,
      moneyStatus: refunds.moneyStatus,
      amountRefunded: refunds.amountRefunded,
      resolvedByUserId: refunds.resolvedByUserId,
      amountPaid: purchases.amountPaid,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.id, refundRequestId))
    .get();
}

function alreadyDecidedError(
  database: Database,
  request: { status: RefundStatus; resolvedByUserId: number | null }
): string {
  const decider = request.resolvedByUserId
    ? database
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, request.resolvedByUserId))
        .get()
    : undefined;

  return `This Refund Request was already ${request.status} by ${decider?.name ?? "another Admin"}.`;
}

/**
 * Approving is final: it creates a Pending Refund for the full amount paid and
 * ends the learner's access to the course straight away.
 */
export function approveRefundRequest(
  database: Database,
  refundRequestId: number,
  adminId: number,
  now = new Date()
): DecisionResult {
  const request = getRequestWithParties(database, refundRequestId);
  if (!request) return { ok: false, error: "Refund Request not found." };

  const approved = database.transaction((tx) => {
    // Guarded on status so a second Admin clicking at the same moment
    // changes nothing.
    const updated = tx
      .update(refunds)
      .set({
        status: RefundStatus.Approved,
        amountRefunded: request.amountPaid,
        moneyStatus: RefundMoneyStatus.Pending,
        resolvedAt: now.toISOString(),
        resolvedByUserId: adminId,
      })
      .where(
        and(
          eq(refunds.id, refundRequestId),
          eq(refunds.status, RefundStatus.Open)
        )
      )
      .returning({ id: refunds.id })
      .get();

    if (!updated) return false;

    tx.delete(enrollments)
      .where(
        and(
          eq(enrollments.userId, request.learnerId),
          eq(enrollments.courseId, request.courseId)
        )
      )
      .run();

    return true;
  });

  if (!approved) {
    const current = getRequestWithParties(database, refundRequestId)!;
    return { ok: false, error: alreadyDecidedError(database, current) };
  }

  return {
    ok: true,
    message: `Approved. ${formatPrice(request.amountPaid)} to send to ${request.learnerName}.`,
    email: buildApprovedEmail(request),
  };
}

/**
 * Declining is final and needs a reason, which the learner is told. They may
 * raise a new Refund Request afterwards.
 */
export function declineRefundRequest(
  database: Database,
  refundRequestId: number,
  adminId: number,
  declineReason: string,
  now = new Date()
): DecisionResult {
  const reason = declineReason.trim();
  if (!reason) {
    return { ok: false, error: "Give the learner a reason for declining." };
  }

  const request = getRequestWithParties(database, refundRequestId);
  if (!request) return { ok: false, error: "Refund Request not found." };

  const updated = database
    .update(refunds)
    .set({
      status: RefundStatus.Declined,
      declineReason: reason,
      resolvedAt: now.toISOString(),
      resolvedByUserId: adminId,
    })
    .where(
      and(
        eq(refunds.id, refundRequestId),
        eq(refunds.status, RefundStatus.Open)
      )
    )
    .returning({ id: refunds.id })
    .get();

  if (!updated) {
    const current = getRequestWithParties(database, refundRequestId)!;
    return { ok: false, error: alreadyDecidedError(database, current) };
  }

  return {
    ok: true,
    message: `Declined. ${request.learnerName} has been told why.`,
    email: buildDeclinedEmail(request, reason),
  };
}

// ─── The money ───

/** A Pending or Failed Refund becomes Issued once the money is confirmed sent. */
export function markRefundIssued(
  database: Database,
  refundRequestId: number,
  now = new Date()
): MoneyResult {
  const request = getRequestWithParties(database, refundRequestId);
  if (!request) return { ok: false, error: "Refund not found." };

  const updated = database
    .update(refunds)
    .set({ moneyStatus: RefundMoneyStatus.Issued, issuedAt: now.toISOString() })
    .where(
      and(
        eq(refunds.id, refundRequestId),
        eq(refunds.status, RefundStatus.Approved),
        inArray(refunds.moneyStatus, [
          RefundMoneyStatus.Pending,
          RefundMoneyStatus.Failed,
        ])
      )
    )
    .returning({ id: refunds.id })
    .get();

  if (!updated) {
    return {
      ok: false,
      error: request.moneyStatus
        ? `This Refund is already ${request.moneyStatus}.`
        : "This Refund Request hasn't been approved.",
    };
  }

  return {
    ok: true,
    message: `Marked as issued. ${request.learnerName} has been emailed.`,
    email: buildIssuedEmail({
      ...request,
      amountRefunded: request.amountRefunded ?? request.amountPaid,
    }),
  };
}

/**
 * A Pending Refund becomes Failed when the money couldn't be sent. The Refund
 * Request stays approved and the learner isn't emailed — the Admin retries.
 */
export function markRefundFailed(
  database: Database,
  refundRequestId: number
): MoneyResult {
  const request = getRequestWithParties(database, refundRequestId);
  if (!request) return { ok: false, error: "Refund not found." };

  const updated = database
    .update(refunds)
    .set({ moneyStatus: RefundMoneyStatus.Failed })
    .where(
      and(
        eq(refunds.id, refundRequestId),
        eq(refunds.moneyStatus, RefundMoneyStatus.Pending)
      )
    )
    .returning({ id: refunds.id })
    .get();

  if (!updated) {
    return {
      ok: false,
      error: request.moneyStatus
        ? `This Refund is already ${request.moneyStatus}.`
        : "This Refund Request hasn't been approved.",
    };
  }

  return {
    ok: true,
    message: "Marked as failed. Try sending it again, then mark it issued.",
    email: null,
  };
}

/**
 * A Failed Refund goes back to Pending while the Admin tries sending it again,
 * so each attempt ends in Issued or Failed and a repeat failure can be recorded.
 */
export function retryRefund(
  database: Database,
  refundRequestId: number
): MoneyResult {
  const request = getRequestWithParties(database, refundRequestId);
  if (!request) return { ok: false, error: "Refund not found." };

  const updated = database
    .update(refunds)
    .set({ moneyStatus: RefundMoneyStatus.Pending })
    .where(
      and(
        eq(refunds.id, refundRequestId),
        eq(refunds.moneyStatus, RefundMoneyStatus.Failed)
      )
    )
    .returning({ id: refunds.id })
    .get();

  if (!updated) {
    return {
      ok: false,
      error: request.moneyStatus
        ? `This Refund is ${request.moneyStatus}, not failed.`
        : "This Refund Request hasn't been approved.",
    };
  }

  return {
    ok: true,
    message: "Back to pending. Mark it issued or failed once you've tried again.",
    email: null,
  };
}

// ─── Emails ───
// There is no mail transport yet; the route logs these.

type EmailParties = {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
};

function buildApprovedEmail(
  input: EmailParties & { amountPaid: number }
): RefundEmail {
  return {
    to: input.learnerEmail,
    subject: `Refund approved — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We've approved your refund request for "${input.courseTitle}".`,
      `${formatPrice(input.amountPaid)}, the full amount you paid, is on its way back to you. We'll email you again once it has been sent.`,
      "",
      `Your access to "${input.courseTitle}" has ended.`,
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

function buildDeclinedEmail(
  input: EmailParties,
  declineReason: string
): RefundEmail {
  return {
    to: input.learnerEmail,
    subject: `Refund request declined — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We've looked at your refund request for "${input.courseTitle}" and can't approve it.`,
      "",
      "Here's why:",
      declineReason,
      "",
      "You still have access to the course. If something changes, you can raise a new refund request from the course page.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

function buildIssuedEmail(
  input: EmailParties & { amountRefunded: number }
): RefundEmail {
  return {
    to: input.learnerEmail,
    subject: `Refund sent — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We've sent your ${formatPrice(input.amountRefunded)} refund for "${input.courseTitle}".`,
      "Depending on your bank, it can take a few days to show on your statement.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}
