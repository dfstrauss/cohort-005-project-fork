# The Refund is stored on its Refund Request's row, and the `refunds` naming stays

The glossary separates a Refund Request (the learner's ask and an Admin's decision) from a Refund (the money). The schema has a single `refunds` table, though, with one row per Refund Request. Its `status` column (`RefundStatus`: open / approved / declined) holds the Refund Request's status. We keep it that way and store the Refund on the same row: `money_status` (`RefundMoneyStatus`: pending / issued / failed), `amount_refunded` and `issued_at`. This works because each Approved Refund Request has exactly one Refund, including across a retry after failure. We don't rename the table or the enum because this repo regularly pulls commits from the upstream course repo, and a rename would conflict with them.

## Considered Options

- **A separate table for the Refund**: rejected, because a one-to-one relationship needs no second table, and splitting it would mean a join for every queue and decision.
- **Rename to `refund_requests` / `RefundRequestStatus`**: rejected for now, because of the upstream conflicts. It's worth revisiting if this repo stops pulling from upstream.

## Consequences

- In code, "refund" usually means a **Refund Request**. Read `refunds.status` and `RefundStatus` as the request's status. The Refund's own status is always `money_status`.
- `money_status`, `amount_refunded` and `issued_at` are null until the Refund Request is approved, and stay null on a declined one.
- If one Refund Request ever needs several Refunds (for example, partial refunds), this decision has to be revisited.
