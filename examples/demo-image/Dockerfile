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
# sunaba-agent ships in this repo — once published, uncomment:
#   RUN npm install -g sunaba-agent
#   EXPOSE 8080 9000
# Or vendor it: run `npm pack` inside packages/agent, COPY the .tgz in:
#   COPY sunaba-agent-*.tgz .
#   RUN npm install -g ./sunaba-agent-*.tgz && rm ./sunaba-agent-*.tgz

CMD ["sleep", "infinity"]
