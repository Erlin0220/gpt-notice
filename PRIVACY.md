# 隐私说明

ChatGPT 任务完成提醒不收集、出售或上传用户数据。

扩展仅在本机执行以下操作：

- 读取 ChatGPT 页面中的生成状态、确认按钮、错误提示、问题标题、思考时间和回复第一行，用于判断任务状态及生成通知。
- 在 `chrome.storage.local` 中保存扩展设置、任务状态、会话地址和短文本摘要。
- 使用 Chrome Notifications API 显示 Windows 系统通知。
- 在用户关闭运行中的 ChatGPT 标签时，在现有普通 Chrome 窗口中创建一个非活动标签，并放入折叠的“GPT 后台”标签组。
- 使用 Chrome Alarms API 定期检查后台标签是否仍存在、是否被丢弃，以及 Content Script 是否正常响应。

扩展不会：

- 调用 ChatGPT 私有接口。
- 读取或导出登录 Cookie。
- 将聊天内容发送到第三方服务器。
- 创建独立的隐藏浏览器进程或 Windows 后台程序。

完全退出 Chrome 后，扩展和后台网页标签都会停止运行。
