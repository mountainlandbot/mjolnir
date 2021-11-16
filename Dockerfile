FROM node:10
COPY . /tmp/src
RUN apt update && apt install -y git \
    && cd /tmp/src \
    && yarn install \
    && cd node_modules/matrix-bot-sdk && yarn install && npm run build && cd ../.. \
    && yarn build \
    && mv lib/ /mjolnir/ \
    && mv node_modules / \
    && cd / \
    && rm -rf /tmp/*

ENV NODE_ENV=production
ENV NODE_CONFIG_DIR=/data/config

CMD node /mjolnir/index.js
VOLUME ["/data"]
