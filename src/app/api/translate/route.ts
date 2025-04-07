import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources/chat';

// 初始化OpenAI客户端
const openai = new OpenAI({
  apiKey: process.env.NEXT_PUBLIC_OPENAI_API_KEY,
});

// 翻译API
export async function POST(req: NextRequest) {
  try {
    const { text, targetLanguage } = await req.json();
    
    if (!text || typeof text !== 'string') {
      return NextResponse.json(
        { error: '无效请求：需要文本参数且必须是字符串' },
        { status: 400 }
      );
    }
    
    if (!targetLanguage || typeof targetLanguage !== 'string') {
      return NextResponse.json(
        { error: '无效请求：需要目标语言参数且必须是字符串' },
        { status: 400 }
      );
    }
    
    // 构建指示语言的提示
    const targetLanguageName = getLanguageName(targetLanguage);
    
    // 构建OpenAI API请求
    const messages = [
      {
        role: "system" as const,
        content: `你是一个高效且精确的翻译工具。翻译以下文本到${targetLanguageName}。只返回翻译后的文本，不要包含任何其他内容，不要解释，不要添加引号或格式标记。保持原始文本的格式和标点符号。`
      },
      { role: "user" as const, content: text }
    ];
    
    // 调用OpenAI API
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      temperature: 0.3,
      max_tokens: Math.max(100, text.length * 2), // 确保有足够的token来完成翻译
    });
    
    // 提取翻译文本
    const translatedText = response.choices[0]?.message?.content?.trim() || '翻译失败';
    
    // 返回结果
    return NextResponse.json({
      originalText: text,
      translatedText: translatedText,
      detectedLanguage: 'auto', // 在这个简单实现中我们不检测源语言
      targetLanguage: targetLanguage
    });
  } catch (error: any) {
    console.error('翻译API错误:', error);
    return NextResponse.json(
      { error: `翻译服务错误: ${error.message}` },
      { status: 500 }
    );
  }
}

// 辅助函数：将语言代码转换为语言名称
function getLanguageName(code: string): string {
  const languageMap: {[key: string]: string} = {
    'en': '英语',
    'zh': '中文',
    'ja': '日语',
    'ko': '韩语',
    'es': '西班牙语',
    'fr': '法语',
    'de': '德语',
    'ru': '俄语',
    'ar': '阿拉伯语',
    'hi': '印地语',
    'pt': '葡萄牙语',
    'it': '意大利语',
    'nl': '荷兰语',
    'el': '希腊语',
    'th': '泰语'
  };
  
  return languageMap[code] || '英语';
} 