# Solemn-Assistant

一個以 TypeScript 撰寫、部署於 Cloudflare Workers 的 LINE Webhook 範例。當收到標記機器人的訊息時，會將問題轉發給 OpenAI 並將回覆傳回 LINE。

## 本地開發
1. 安裝依賴：
   ```bash
   npm install
   ```
2. 啟動模擬開發伺服器：
   ```bash
   npm run dev
   ```

## 部署
1. 設定環境變數／機敏資訊（建議使用 `wrangler secret put`）：
   - `OPENAI_API_KEY`：OpenAI API 金鑰
   - `LINE_CHANNEL_ACCESS_TOKEN`：LINE Messaging API Channel access token
   - `LINE_CHANNEL_SECRET`：LINE Channel secret
   - `LINE_BOT_USER_ID`：機器人自己的 userId（用於辨識被標記）
   - （可選）`OPENAI_MODEL`：預設為 `gpt-4o-mini`
2. 執行部署：
   ```bash
   npm run deploy
   ```

## 運作流程
- 驗證 LINE Webhook 簽章以確保來源可信。
- 解析訊息事件，確認是否有標記機器人本身。
- 將標記文字中的 mention 內容移除後作為提問，請求 OpenAI Chat Completions API。
- 取得回覆後呼叫 LINE Reply API 將答案傳回對話。
