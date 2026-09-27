# Placeholder deployment config — target (host / Vercel / container platform) to be confirmed.
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY web/package.json web/
COPY api/package.json api/
RUN npm install
COPY . .
RUN npm run build --workspace web

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 4000
CMD ["node", "api/src/index.js"]
