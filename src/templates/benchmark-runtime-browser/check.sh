set -eu
curl --fail --silent "$SC_CANDIDATE_URL" | rg 'Candidate ready'
