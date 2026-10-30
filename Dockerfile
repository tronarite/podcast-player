# Reproductor de podcasts: sin dependencias, solo Node.
FROM node:20-alpine
WORKDIR /app
# Código propiedad de root y de solo lectura; la app corre como el usuario sin privilegios «node».
COPY server.js manage-users.js ./
COPY lib ./lib
COPY public ./public
RUN chown -R root:root /app && chmod -R a-w,a+rX /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=48213 PODCAST_DIR=/podcasts
EXPOSE 48213
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:48213/api/me > /dev/null || exit 1
USER node
CMD ["node", "server.js"]
