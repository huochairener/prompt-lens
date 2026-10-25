import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listAnalysisModelOptions } from "@/lib/ai/analysis-options";

/**
 * 视频分析页的模型下拉数据源。
 *
 * 直接读**当前用户**的 AI 提供商目录（配置文件 + 环境变量 + 他自己的在线配置），
 * 所以设置页改完模型/Key，刷新页面就能选到，不需要重新部署。
 * 平台试用已移除：没有可用 Key 的提供商会置灰，不会回退到任何共享密钥。
 */
export async function GET(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { options, defaultId } = await listAnalysisModelOptions(session.user.id);

    return NextResponse.json({ options, defaultId });
  } catch (error) {
    console.error("[analyze/models] 读取可用模型失败：", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
