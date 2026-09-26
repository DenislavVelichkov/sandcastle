FROM sandcastle:limit-items-proof
RUN corepack prepare pnpm@11.19.0 --activate
RUN mkdir -p /home/agent/.local/bin && printf '#!/bin/sh\nexport pnpm_config_pm_on_fail=ignore\nexport pnpm_config_verify_deps_before_run=false\nexec node /home/agent/.cache/node/corepack/v1/pnpm/11.19.0/bin/pnpm.mjs "$@"\n' > /home/agent/.local/bin/pnpm && chmod +x /home/agent/.local/bin/pnpm
ENV PATH=/home/agent/.local/bin:$PATH
