FROM node:24-slim

WORKDIR /app
COPY . .

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

# 零第三方依赖：直接启动 Node 服务（同时托管 frontend/ 静态界面与 /api）
CMD ["node", "backend/server.js"]
