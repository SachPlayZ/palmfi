# Two shared CRE workflows serve every Vault through the Hub

CRE allows at most 3 registered workflows per organisation, so we can't run one workflow per Owner. Every Vault sends its events through the Hub, and two shared workflows serve all of them: the Sentinel (log-triggered scoring and incident response) and the Reconciler (scheduled catch-up, reserve and delegation checks, Market modes, heartbeat). Each Owner's requests are still scored against that Owner's own profile, looked up by vault address. The five workflows in the brief are merged into these two.
