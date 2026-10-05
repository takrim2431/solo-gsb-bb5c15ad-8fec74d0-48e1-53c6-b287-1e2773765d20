# ---- 构建阶段 ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# 仅复制依赖清单以利用层缓存
COPY package.json package-lock.json* ./
RUN npm ci

# 编译 TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 剔除开发依赖
RUN npm prune --omit=dev

# ---- 运行阶段 ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 运行时依赖（无 devDependencies）
COPY --from=build /app/node_modules ./node_modules
# 编译产物 dist/src/*.js
COPY --from=build /app/dist ./dist
# schema.sql 初始化脚本（应用启动时执行，幂等）
COPY --from=build /app/src/schema.sql ./src/schema.sql
COPY package.json ./

ENV PORT=3000
ENV SCHEMA_PATH=/app/src/schema.sql
EXPOSE 3000

# 内置数据库等待与 schema 初始化，无需外部迁移容器
CMD ["node", "dist/src/start.js"]
