import { createChatCompletion } from "@/lib/ai/providers/client";
import { getProviderConfig } from "@/lib/ai/providers/config";
import { resolveProviderApiKey } from "@/lib/ai/providers/resolve-key";
import { resolveActiveProviderId } from "@/lib/ai/providers/runtime";
import type { ProviderConfig } from "@/lib/ai/providers/types";

// 时间轴片段
export interface VideoSegment {
  startTime: number; // 秒
  endTime: number;   // 秒
}

// 转场效果
export type TransitionType =
  | "none"
  | "fade"
  | "dissolve"
  | "wipe_left"
  | "wipe_right"
  | "slide_left"
  | "slide_right"
  | "zoom_in"
  | "blur";

// 调色预设
export type ColorGrade =
  | "none"
  | "vintage"
  | "cinematic"
  | "warm"
  | "cool"
  | "dramatic"
  | "fade";

// 剪辑指令
export interface EditInstruction {
  segments: VideoSegment[];        // 要保留的片段
  transitions: TransitionType[];   // 转场效果
  transitionDuration: number;      // 转场时长（秒）
  music?: {
    url?: string;                 // 音乐文件 URL
    name?: string;                 // 预设音乐名称
    volume: number;                // 音量 0-1
  };
  colorGrade: ColorGrade;         // 调色
  outputDuration?: number;        // 输出视频总时长
}

// 解析结果
export interface ParseResult {
  success: boolean;
  instruction?: EditInstruction;
  error?: string;
}

/** 提供商 id，取值见 config/ai-providers.json */
export type ApiProvider = string;

/**
 * 调用 AI 解析剪辑指令
 */
export async function parseEditInstruction(
  userId: string,
  prompt: string,
  videoDuration: number,
  provider?: ApiProvider
): Promise<ParseResult> {
  const providerId = provider?.trim() || (await resolveActiveProviderId(userId));

  let providerConfig: ProviderConfig;
  try {
    providerConfig = getProviderConfig(userId, providerId);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : `未知的 AI 提供商：${providerId}`,
    };
  }

  const apiKey = await resolveProviderApiKey(providerConfig, { scope: userId });
  if (!apiKey) {
    return {
      success: false,
      error: `未配置 ${providerConfig.label} 的 API Key，请在设置或环境变量中添加`,
    };
  }

  const systemPrompt = `你是一个视频剪辑助手。用户会给你一个剪辑描述，你需要解析并生成剪辑指令。

视频总时长: ${videoDuration} 秒

请根据用户描述生成剪辑指令。用户描述可能是：
- "把第0-5秒和第10-20秒拼接"
- "保留前10秒"
- "只取5-15秒这段"
- "加上淡入淡出转场"
- "配个欢快的音乐"
- "调成电影色调"

请用 JSON 格式返回，必须包含以下字段：
{
  "segments": [{"startTime": 0, "endTime": 5}, ...],  // 要保留的视频片段
  "transitions": ["fade", "none"],  // 转场效果数组，对应片段之间的转场
  "transitionDuration": 0.5,  // 转场时长（秒）
  "music": {"name": "欢快", "volume": 0.3},  // 音乐设置
  "colorGrade": "none"  // 调色: none/vintage/cinematic/warm/cool/dramatic/fade
}

支持的转场效果: none/fade/dissolve/wipe_left/wipe_right/slide_left/slide_right/zoom_in/blur
支持的调色: none/vintage/cinematic/warm/cool/dramatic/fade

如果用户没有指定具体时间，默认保留整个视频。
如果用户没有指定音乐，不返回 music 字段。
如果用户没有指定转场，默认用 fade。
如果用户没有指定调色，默认用 none。

只返回 JSON，不要其他内容。`;

  const userMessage = `视频总时长 ${videoDuration} 秒，我的剪辑需求是：${prompt}`;

  try {
    const completion = await createChatCompletion({
      scope: userId,
      provider: providerId,
      apiKey,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      maxOutputTokens: providerConfig.maxOutputTokens,
      temperature: providerConfig.temperature,
    });

    const jsonMatch = completion.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: false, error: "AI 返回格式错误" };
    }

    return validateAndFixInstruction(JSON.parse(jsonMatch[0]), videoDuration);
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI 调用失败";
    console.error("AI 解析失败:", message);
    return { success: false, error: message };
  }
}

/**
 * 验证并修复指令
 */
function validateAndFixInstruction(
  parsed: any,
  videoDuration: number
): ParseResult {
  // 验证 segments
  const segments: VideoSegment[] = [];

  if (parsed.segments && Array.isArray(parsed.segments)) {
    for (const seg of parsed.segments) {
      const start = Math.max(0, parseFloat(seg.startTime) || 0);
      const end = Math.min(videoDuration, parseFloat(seg.endTime) || videoDuration);

      if (end > start) {
        segments.push({ startTime: start, endTime: end });
      }
    }
  }

  // 如果没有指定片段，默认整个视频
  if (segments.length === 0) {
    segments.push({ startTime: 0, endTime: videoDuration });
  }

  // 验证转场
  const validTransitions: TransitionType[] = [
    "none",
    "fade",
    "dissolve",
    "wipe_left",
    "wipe_right",
    "slide_left",
    "slide_right",
    "zoom_in",
    "blur",
  ];

  const transitions: TransitionType[] = [];

  if (parsed.transitions && Array.isArray(parsed.transitions)) {
    for (const t of parsed.transitions) {
      if (validTransitions.includes(t)) {
        transitions.push(t);
      } else {
        transitions.push("fade");
      }
    }
  }

  // 确保转场数组长度正确
  while (transitions.length < segments.length - 1) {
    transitions.push("fade");
  }

  // 验证调色
  const validGrades: ColorGrade[] = [
    "none",
    "vintage",
    "cinematic",
    "warm",
    "cool",
    "dramatic",
    "fade",
  ];

  const colorGrade: ColorGrade = validGrades.includes(parsed.colorGrade)
    ? parsed.colorGrade
    : "none";

  // 验证转场时长
  const transitionDuration = Math.max(
    0.1,
    Math.min(3, parseFloat(parsed.transitionDuration) || 0.5)
  );

  // 音乐
  const music = parsed.music
    ? {
        name: parsed.music.name || "",
        volume: Math.max(0, Math.min(1, parseFloat(parsed.music.volume) || 0.3)),
      }
    : undefined;

  return {
    success: true,
    instruction: {
      segments,
      transitions,
      transitionDuration,
      music,
      colorGrade,
    },
  };
}
