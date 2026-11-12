# Approving a Refund Request ends access immediately, by deleting the enrollment

Payouts are manual, so the money for a Refund can take days to arrive, and longer if the Refund fails and has to be retried. We still end the learner's access to the course the moment an Admin approves their Refund Request, not when the Refund is Issued. The decision is what ends the deal, and waiting for Issued would let a learner keep the course and a promised refund for as long as a failed payout takes to sort out. Access is ended by deleting the learner's enrollment for that course.

## Considered Options

- **End access when the Refund is Issued**: rejected, because a Failed Refund can stay unresolved for a long time and the learner would keep watching throughout.
- **Never remove access**: rejected, because it gives the course away for free.
- **End access when the Refund Request is raised**: rejected, because a Declined Refund Request would then need access put back, and the learner would lose the course over a request that might not succeed.

## Consequences

- Deleting the enrollment loses its `enrolledAt` and `completedAt` for good. Lesson progress, quiz attempts and ratings are kept.
- If the learner buys the course again, they get a fresh enrollment and a new purchase. Their old progress shows up again because it was never deleted.
- Because a decision is final, there is no "reinstate access" path. Putting a learner back means creating a new enrollment by hand.
