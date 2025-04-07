import { NextRequest, NextResponse } from 'next/server';

// 语言检测API
export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();
    
    if (!text || typeof text !== 'string') {
      return NextResponse.json(
        { error: 'Invalid request: text is required and must be a string' },
        { status: 400 }
      );
    }
    
    // 构建OpenAI API请求
    const messages = [
      {
        role: "system",
        content: "You are a language detection tool. Analyze the text and return ONLY the full name of the dominant language in English (the language with most characters). Return only the language name like 'English', 'Chinese', 'French', 'Spanish', 'Japanese', etc. No explanation or codes."
      },
      { role: "user", content: text }
    ];
    
    // 从环境变量或配置中获取API密钥
    const OPENAI_API_KEY = process.env.NEXT_PUBLIC_OPENAI_API_KEY;
    
    if (!OPENAI_API_KEY) {
      console.error('OpenAI API key not found');
      return NextResponse.json(
        { error: 'Server configuration error' },
        { status: 500 }
      );
    }
    
    // 调用OpenAI API
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages,
        temperature: 0,
        max_tokens: 10,
      }),
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      console.error('OpenAI API error:', errorData);
      return NextResponse.json(
        { error: 'Error from language detection service', details: errorData },
        { status: 500 }
      );
    }
    
    const data = await response.json();
    const languageName = data.choices?.[0]?.message?.content?.trim() || 'Unknown';
    
    return NextResponse.json({ languageCode: languageName });
  } catch (error) {
    console.error('Error in language detection API:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
} 