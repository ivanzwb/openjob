/**
 * 面经摄入（ingest）prompt：把拆出的真题匹配到考点节点。
 * 拆题（REPORT_EXTRACT_SYSTEM）在 shared/diagnosis/prompts，这里是匹配部分。
 */

export const MATCH_SYSTEM = `你是面试真题匹配助手。将每道面试题匹配到最相关的知识点节点。
- 有合适节点时填 nodeName（必须与节点列表完全一致）
- 匹配不上时 nodeName 为 null，并给出 suggestedName 作为新考点名
- confidence 0-1

输出 JSON：
{
  "matches": [
    { "questionIndex": 0, "nodeName": "Redis 持久化", "confidence": 0.85, "suggestedName": null }
  ]
}`;