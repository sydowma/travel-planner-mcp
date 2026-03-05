# Travel Planner MCP Server

旅游规划 MCP 服务器，支持航班搜索、天气查询、汇率查询和行程规划。

## 功能

- **search_flights**: 航班搜索，支持深圳/香港出发
- **get_weather**: 天气查询，包含樱花季预测
- **get_exchange_rate**: 汇率查询 (CNY/JPY)
- **plan_trip**: 行程规划建议
- **analyze_best_dates**: 最佳出行日期分析
- **scan_trip_windows**: 批量抓取日期窗口，推荐“周四/周五出发、4天左右”最佳组合

## 安装

```bash
npm install
npm run build
```

## 配置 (可选)

复制 `.env.example` 为 `.env`（可不填）：

```bash
cp .env.example .env
```

- `OPENWEATHER_API_KEY`: OpenWeatherMap 实时天气（不填则使用内置历史/季节建议）
- `EXCHANGE_RATE_API_KEY`: Exchange Rate API 实时汇率（不填则自动回退免费汇率接口）

说明：
- `scan_trip_windows` / `search_flights` 当前不依赖 `SERP_API_KEY`。
- 不配置任何 API Key 也能正常用核心行程扫描能力。

> 不配置 API Keys 也可以使用，会返回有用的建议和参考数据。

## 在 Claude Code 中使用

在 Claude Code 配置文件中添加：

```json
{
  "mcpServers": {
    "travel-planner": {
      "command": "node",
      "args": ["/Users/oker/github/ai/travel-planner-mcp/dist/index.js"]
    }
  }
}
```

或者开发模式：

```json
{
  "mcpServers": {
    "travel-planner": {
      "command": "npx",
      "args": ["tsx", "/Users/oker/github/ai/travel-planner-mcp/src/index.ts"]
    }
  }
}
```

## 使用示例

配置好后，你可以在 Claude Code 中这样问：

```
帮我查一下3月份从深圳去东京的航班，想看樱花
```

```
3月27-28日从香港出发去东京，帮我分析一下这个时间合适吗
```

```
帮我规划一个3天东京行程，预算中等，喜欢美食和动漫
```

```
帮我扫描 2026年3月 从深圳/香港出发去东京，周四或周五出发，4天左右，找出最合适时间段
```

## 3月东京出行建议

| 日期 | 樱花状态 | 价格水平 | 推荐指数 |
|------|----------|----------|----------|
| 3/5-3/6 | 未开 | 低 | ⭐⭐⭐ |
| 3/12-3/13 | 未开 | 中 | ⭐⭐⭐⭐ |
| 3/19-3/20 | 初绽 | 中 | ⭐⭐⭐⭐⭐ |
| 3/26-3/27 | 盛开 | 高 | ⭐⭐⭐⭐⭐ |

## 机场代码参考

| 城市 | 代码 |
|------|------|
| 深圳 | SZX |
| 香港 | HKG |
| 东京成田 | NRT |
| 东京羽田 | HND |
| 大阪关西 | KIX |
| 札幌 | CTS |
