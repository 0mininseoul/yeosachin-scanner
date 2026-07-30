# Earlybird schema-failure recovery CLI

`npm run earlybird:recover-schema-failed` deliberately does not load a local
`.env.local` file. Run it only in the approved operator environment, where the
canonical runtime configuration is already inherited by the process.

The operator environment must provide the same Supabase admin and task-dispatch
configuration as the production application. In particular,
`NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` must be present, and
the enabled preflight/analysis task configuration must be valid. Never paste
their values into a command, terminal transcript, issue, or document.

After verifying the exact paid order is eligible, invoke the command with one
order UUID and `--confirm-schema-failure-recovery`. The command prints only a
bounded recovery disposition; it does not print order, request, user, payment,
or configuration identifiers. A non-zero exit means no recovery should be
assumed; inspect the approved operational logs before any retry.
