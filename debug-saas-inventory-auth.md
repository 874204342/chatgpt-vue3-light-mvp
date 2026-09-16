# SaaS 库存登录态调试记录

状态：[OPEN]
会话：saas-inventory-auth

## 症状
登录成功并拿到 Token 后，AI 查询库存仍提示未登录，库存接口没有被调用。

## 可证伪假设
1. 登录响应的 `Set-Cookie` 未被浏览器保存。
2. 聊天请求未携带 `saas_session` Cookie。
3. 登录与聊天请求到达了不同的服务端进程或端口，导致内存会话不一致。
4. Cookie 已携带，但服务端会话因重启或过期已不存在。

## 观测步骤
- 登录后检查 `/local-ai/api/saas/auth/login` 的响应头和浏览器 Cookie。
- 登录后访问 `/local-ai/api/saas/auth/status`，记录 authenticated 状态。
- 发送“查询原片库存”，检查 `/local-ai/api/chat` 请求 Cookie，以及服务端库存查询日志。

## 约束
- 在取得运行时证据前不修改业务逻辑。
- 不记录 Token、密码或完整 Cookie 值，仅记录是否存在及会话状态。
