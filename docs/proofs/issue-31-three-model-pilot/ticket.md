# Preserve streamed file-log chunks

Fix the file logger so raw streamed chunks stay contiguous. If a structured log entry follows streamed output, start that entry on a new line. Add focused regression coverage for both behaviors.

Follow this repository's conventions: change only relevant source, tests, and the required patch changeset; use pnpm; do not add lockfile or workspace metadata. Commit the result. An independent host check will run typecheck, build, and tests. Work only in this answer-free repository.
