# Demo MicroVM image — minimal sandbox with common shell tools.
# Build:  cd examples/demo-image && sunaba build
#         (this dir's sunaba.json is read; it still needs
#          artifactBucket + buildRoleArn filled in, or --bucket/--role)
FROM node:22-alpine

RUN apk add --no-cache bash curl jq python3

WORKDIR /app

# Optional guest agent for the HTTP exec/fs API on :8080 and
# lifecycle hooks on :9000. The managed shell (SHELL_INGRESS) works
# without it — the agent is only needed if you want request()/hooks.
# To use it, uncomment these lines and replace the CMD below with
# CMD ["sunaba-agentd"] — the agent only answers while it runs:
#   RUN npm install -g sunaba-agent
#   EXPOSE 8080 9000
# Or vendor a local build: after `npm ci`, run at the repo root
# `npm pack -w packages/agent --pack-destination examples/demo-image`
# (prepack builds dist/), then use these in place of the RUN above:
#   COPY sunaba-agent-*.tgz .
#   RUN npm install -g ./sunaba-agent-*.tgz && rm ./sunaba-agent-*.tgz

CMD ["sleep", "infinity"]
