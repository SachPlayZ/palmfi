# The Hub ignores bad CRE reports instead of reverting

The KeystoneForwarder marks a report as used only if the receiver's `onReport` succeeds, so a report that reverts can be replayed later. The Hub therefore reverts only when the caller isn't the forwarder. Any problem with a report's content (expired, duplicate, request-hash mismatch, a CLEAR after a FLAG, an untrusted workflow ID) is dropped and recorded as a `ReportRejected(reason)` event. The cost: a write that "succeeds" may have done nothing, so the Reconciler and the frontend must read state, not tx status.
