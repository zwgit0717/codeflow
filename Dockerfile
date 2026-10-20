FROM node:alpine

WORKDIR /srv/app

COPY server.js landing.html package.json ./

RUN addgroup -S app && adduser -S app -G app \
 && chown -R app:app /srv/app \
 && chmod 755 /srv/app

USER app

ENV NODE_ENV=production \
    WORK_DIR=/srv/app/.runtime

EXPOSE 3000

CMD ["node", "server.js"]
