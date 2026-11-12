import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import type { Route } from "./+types/admin.refunds";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { RefundMoneyStatus, UserRole, users } from "~/db/schema";
import { db } from "~/db";
import { eq } from "drizzle-orm";
import {
  approveRefundRequest,
  declineRefundRequest,
  getRefundReviewQueue,
  markRefundFailed,
  markRefundIssued,
  retryRefund,
  type RefundEmail,
} from "~/lib/refund-review.server";
import { formatPrice } from "~/lib/utils";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Skeleton } from "~/components/ui/skeleton";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Inbox,
  Receipt,
} from "lucide-react";
import { data, isRouteErrorResponse, Link } from "react-router";

const refundActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("approve"),
    refundRequestId: z.coerce.number().int(),
  }),
  z.object({
    intent: z.literal("decline"),
    refundRequestId: z.coerce.number().int(),
    declineReason: z
      .string()
      .trim()
      .min(1, "Give the learner a reason for declining.")
      .max(1000, "Keep the reason under 1000 characters."),
  }),
  z.object({
    intent: z.literal("mark-issued"),
    refundRequestId: z.coerce.number().int(),
  }),
  z.object({
    intent: z.literal("mark-failed"),
    refundRequestId: z.coerce.number().int(),
  }),
  z.object({
    intent: z.literal("retry"),
    refundRequestId: z.coerce.number().int(),
  }),
]);

async function requireAdmin(request: Request) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to review refunds.", {
      status: 401,
    });
  }

  const currentUser = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  // Admins only — an Instructor never decides refunds, even on their own course.
  if (!currentUser || currentUser.role !== UserRole.Admin) {
    throw data("Only admins can review refunds.", { status: 403 });
  }

  return currentUser;
}

// There is no mail transport yet, so the built message goes to the server log.
function logEmail(email: RefundEmail) {
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);
}

export function meta() {
  return [
    { title: "Refunds — Cadence" },
    { name: "description", content: "Decide Refund Requests and send Refunds" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  return getRefundReviewQueue(db);
}

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request);

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundActionSchema);

  if (!parsed.success) {
    return data(
      { error: Object.values(parsed.errors)[0] ?? "Invalid input." },
      { status: 400 }
    );
  }

  const input = parsed.data;
  const result =
    input.intent === "approve"
      ? approveRefundRequest(db, input.refundRequestId, admin.id)
      : input.intent === "decline"
        ? declineRefundRequest(
            db,
            input.refundRequestId,
            admin.id,
            input.declineReason
          )
        : input.intent === "mark-issued"
          ? markRefundIssued(db, input.refundRequestId)
          : input.intent === "mark-failed"
            ? markRefundFailed(db, input.refundRequestId)
            : retryRefund(db, input.refundRequestId);

  if (!result.ok) {
    return data({ error: result.error }, { status: 409 });
  }

  if (result.email) logEmail(result.email);

  return { success: true, message: result.message };
}

type Queue = Awaited<ReturnType<typeof loader>>;
type OpenRequest = Queue["needsDecision"][number];
type RefundToSend = Queue["moneyToSend"][number];

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatDuration(seconds: number) {
  const totalMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

type ActionResult = { success?: boolean; message?: string; error?: string };

function useToastOnResult(fetcher: ReturnType<typeof useFetcher<ActionResult>>) {
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.success) toast.success(fetcher.data.message);
    if (fetcher.data.error) toast.error(fetcher.data.error);
  }, [fetcher.state, fetcher.data]);
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
      <AlertTriangle className="size-3" />
      {children}
    </span>
  );
}

function Evidence({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}

function OpenRequestRow({ request }: { request: OpenRequest }) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState<"approve" | "decline" | null>(
    null
  );
  const [declineReason, setDeclineReason] = useState("");
  const fetcher = useFetcher<ActionResult>();
  useToastOnResult(fetcher);

  const busy = fetcher.state !== "idle";
  const windowClosed = request.daysLeftInWindow < 0;
  const amount = formatPrice(request.amountPaid);

  function submit(intent: "approve" | "decline") {
    fetcher.submit(
      {
        intent,
        refundRequestId: String(request.id),
        ...(intent === "decline" ? { declineReason: declineReason.trim() } : {}),
      },
      { method: "post" }
    );
  }

  return (
    <li className="border-b border-border last:border-0">
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {request.learnerName} · {request.courseTitle}
          </span>
          <span className="block text-xs text-muted-foreground">
            Requested {formatDate(request.requestedAt)}
          </span>
        </span>
        <span className="flex items-center gap-2">
          {windowClosed && <Warning>Window closed</Warning>}
          {request.overWatchLimit && <Warning>Over watch cap</Warning>}
          {request.earlierDeclined.length > 0 && (
            <Warning>Declined before</Warning>
          )}
          <span className="text-sm font-medium">{amount}</span>
        </span>
      </button>

      {expanded && (
        <div className="space-y-6 px-4 pb-5 pl-11">
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Evidence label="Learner">
              {request.learnerName}
              <span className="block text-muted-foreground">
                {request.learnerEmail}
              </span>
            </Evidence>
            <Evidence label="Course and amount">
              {request.courseTitle}
              <span className="block text-muted-foreground">
                {amount} paid
              </span>
            </Evidence>
            <Evidence label="Refund window">
              Bought {formatDate(request.purchasedAt)}
              <span className="block">
                {windowClosed ? (
                  <Warning>
                    Closed {-request.daysLeftInWindow}{" "}
                    {request.daysLeftInWindow === -1 ? "day" : "days"} ago
                  </Warning>
                ) : (
                  <span className="text-muted-foreground">
                    {request.daysLeftInWindow === 0
                      ? "Last day today"
                      : `${request.daysLeftInWindow} ${request.daysLeftInWindow === 1 ? "day" : "days"} left`}
                  </span>
                )}
              </span>
            </Evidence>
            <Evidence label="Watched">
              {formatDuration(request.secondsWatched)} of{" "}
              {formatDuration(request.watchLimitSeconds)} cap
              {request.overWatchLimit && (
                <span className="block">
                  <Warning>Passed the cap since asking</Warning>
                </span>
              )}
            </Evidence>
            <Evidence label="Lesson progress">
              {request.lessonProgress.completed} of{" "}
              {request.lessonProgress.total} completed
              {request.lessonProgress.inProgress > 0 && (
                <span className="block text-muted-foreground">
                  {request.lessonProgress.inProgress} in progress
                </span>
              )}
            </Evidence>
          </dl>

          <Evidence label="Their reason">
            <blockquote className="border-l-2 border-border pl-3 whitespace-pre-wrap">
              {request.reason}
            </blockquote>
          </Evidence>

          {request.earlierDeclined.length > 0 && (
            <Evidence label="Declined before on this purchase">
              <ul className="space-y-3">
                {request.earlierDeclined.map((earlier) => (
                  <li key={earlier.id} className="rounded border border-border p-3">
                    <p className="text-xs text-muted-foreground">
                      Asked {formatDate(earlier.requestedAt)}, declined{" "}
                      {formatDate(earlier.resolvedAt)}
                    </p>
                    <p className="mt-1">
                      <span className="text-muted-foreground">They said: </span>
                      {earlier.reason}
                    </p>
                    <p className="mt-1">
                      <span className="text-muted-foreground">We said: </span>
                      {earlier.declineReason}
                    </p>
                  </li>
                ))}
              </ul>
            </Evidence>
          )}

          {confirming === null && (
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setConfirming("approve")}>
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirming("decline")}
              >
                Decline
              </Button>
            </div>
          )}

          {confirming === "approve" && (
            <div className="rounded border border-border bg-muted/50 p-4">
              <p className="text-sm">
                Approve a {amount} refund to {request.learnerName}? Their access
                to {request.courseTitle} ends now. This can't be undone.
              </p>
              <div className="mt-3 flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => submit("approve")}>
                  Confirm approve
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setConfirming(null)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {confirming === "decline" && (
            <div className="rounded border border-border bg-muted/50 p-4">
              <label
                htmlFor={`decline-reason-${request.id}`}
                className="text-sm font-medium"
              >
                Why are you declining? {request.learnerName} will be emailed this.
              </label>
              <Textarea
                id={`decline-reason-${request.id}`}
                value={declineReason}
                onChange={(e) => setDeclineReason(e.target.value)}
                className="mt-2"
                rows={3}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                This can't be undone. They can raise a new Refund Request.
              </p>
              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy || !declineReason.trim()}
                  onClick={() => submit("decline")}
                >
                  Confirm decline
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setConfirming(null)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// The actions cell always holds two fixed-width slots, whatever the status,
// so a button never slides under the cursor after a click. Slot 1 never holds
// an action that confirms Mark issued: a double-click can't issue a Refund.
const SLOT = "h-7 w-28 text-xs";

function RefundToSendRow({ refund }: { refund: RefundToSend }) {
  const fetcher = useFetcher<ActionResult>();
  useToastOnResult(fetcher);
  const [confirmingIssued, setConfirmingIssued] = useState(false);
  const busy = fetcher.state !== "idle";
  const failed = refund.moneyStatus === RefundMoneyStatus.Failed;
  const amount = formatPrice(refund.amountRefunded);

  function submit(intent: "mark-issued" | "mark-failed" | "retry") {
    setConfirmingIssued(false);
    fetcher.submit(
      { intent, refundRequestId: String(refund.id) },
      { method: "post" }
    );
  }

  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-4 py-3 text-sm">
        <span className="font-medium">{refund.learnerName}</span>
        <span className="block text-xs text-muted-foreground">
          {refund.learnerEmail}
        </span>
      </td>
      <td className="px-4 py-3 text-sm">{refund.courseTitle}</td>
      <td className="px-4 py-3 text-sm font-medium">{amount}</td>
      <td className="px-4 py-3 text-sm text-muted-foreground">
        {formatDate(refund.approvedAt)}
        {refund.approvedByName && (
          <span className="block text-xs">by {refund.approvedByName}</span>
        )}
      </td>
      <td className="px-4 py-3 text-sm">
        {failed ? <Warning>Failed</Warning> : "Pending"}
      </td>
      <td className="px-4 py-3 align-top">
        <div className="flex gap-1">
          {confirmingIssued ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                className={SLOT}
                disabled={busy}
                onClick={() => setConfirmingIssued(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className={SLOT}
                disabled={busy}
                onClick={() => submit("mark-issued")}
              >
                Confirm issued
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                className={SLOT}
                disabled={busy}
                onClick={() => setConfirmingIssued(true)}
              >
                Mark issued
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className={SLOT}
                disabled={busy}
                onClick={() => submit(failed ? "retry" : "mark-failed")}
              >
                {failed ? "Retry" : "Mark failed"}
              </Button>
            </>
          )}
        </div>
        {confirmingIssued && (
          <p className="mt-1 w-[14.25rem] text-xs text-muted-foreground">
            Emails {refund.learnerName} that {amount} has been sent. This
            can&apos;t be undone.
          </p>
        )}
      </td>
    </tr>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="py-8 text-center">
        <Inbox className="mx-auto mb-3 size-8 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">{children}</p>
      </CardContent>
    </Card>
  );
}

export function HydrateFallback() {
  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <div className="mb-8">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="mt-2 h-5 w-80" />
      </div>
      <Skeleton className="mb-3 h-6 w-48" />
      <Skeleton className="mb-8 h-32 w-full" />
      <Skeleton className="mb-3 h-6 w-40" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { needsDecision, moneyToSend } = loaderData;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Refunds</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refunds</h1>
        <p className="mt-1 text-muted-foreground">
          Decide Refund Requests, then record when the money has been sent
        </p>
      </div>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold">
          Needs a decision{" "}
          <span className="text-muted-foreground">({needsDecision.length})</span>
        </h2>
        {needsDecision.length === 0 ? (
          <EmptyState>No Refund Requests waiting for a decision.</EmptyState>
        ) : (
          <Card>
            <CardContent className="p-0">
              <ul>
                {needsDecision.map((request) => (
                  <OpenRequestRow key={request.id} request={request} />
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">
          Money to send{" "}
          <span className="text-muted-foreground">({moneyToSend.length})</span>
        </h2>
        {moneyToSend.length === 0 ? (
          <EmptyState>No Refunds waiting to be sent.</EmptyState>
        ) : (
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border bg-muted/50">
                      {[
                        ["Learner", ""],
                        ["Course", ""],
                        ["Amount", ""],
                        ["Approved", ""],
                        // Fixed widths so the columns don't reflow when a
                        // row's status or buttons change.
                        ["Status", "w-28"],
                        ["Actions", "w-[16.25rem]"],
                      ].map(([heading, width]) => (
                        <th
                          key={heading}
                          className={`px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground ${width}`}
                        >
                          {heading}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {moneyToSend.map((refund) => (
                      <RefundToSendRow key={refund.id} refund={refund} />
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading refunds.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message =
        typeof error.data === "string"
          ? error.data
          : "Only admins can review refunds.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <Receipt className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
