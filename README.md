# AI 决策矩阵

根据用户提供的 AI 矩阵截图搭建的响应式股票研究问答网站。前端在 `dist/index.html`，服务端在 `api/analyze.js`。四种模式分别调用 GPT-6 Luna、Sol 和 Astra；联网模式通过 Responses API 的网页搜索工具引用公开来源。网站尚未接入交易所授权行情，因此不标称实时报价。

## 在线部署

- Render：`render.yaml` 和 `render/server.js` 提供网页与 API 的同域部署。
- Vercel：`api/analyze.js` 是 Node.js Function，`public/index.html` 是网页。
- GitHub Pages：仅能托管静态网页；要启用提问功能，需把 `window.AI_MATRIX_API_URL` 指向已部署的 API。

生产环境必须通过托管平台的密钥设置保存 `OPENAI_API_KEY` 和 `SITE_ACCESS_TOKEN`。两者都不能进入公开仓库。`.env.local` 已被 `.gitignore` 排除。

站点访问码用于限制个人使用的模型额度，并在浏览器的当前会话中保存。它不替代面向公众网站所需的正式用户账户、配额和滥用防护。

## 本地运行

在项目根目录为运行环境提供上述两个变量，然后运行：

```powershell
npm start
```

页面位于 `http://localhost:10000/`，API 位于 `http://localhost:10000/api/analyze`。`GPT-6-迁移计划.md` 记录了后续行情服务的接入工作。
