import { NextRequest, NextResponse } from 'next/server';
import { textToSpeech } from '@/app/lib/textToSpeech';

// Map language codes to the appropriate Shimmer Turbo voice
function getShimmerVoiceForLanguage(language: string): string {
  // Handle empty language
  if (!language) {
    console.log('No language provided, defaulting to English voice');
    return 'en-US-JennyNeural';
  }
  
  // Extract the base language from the locale and normalize to lowercase
  const baseLanguage = language.split('-')[0].toLowerCase();
  
  console.log(`Getting voice for language: ${language}, base language: ${baseLanguage}`);
  
  // Map to appropriate neural voices (using verified working voices)
  switch (baseLanguage) {
    case 'en':
      return 'en-US-JennyNeural'; // Use Jenny instead of Shimmer which might not be available
    case 'zh':
      return 'zh-CN-XiaoxiaoNeural'; // Standard neural voice for Chinese
    case 'es':
      return 'es-ES-ElviraNeural'; // Standard neural voice for Spanish
    case 'fr':
      return 'fr-FR-DeniseNeural'; // Standard neural voice for French
    case 'de':
      return 'de-DE-KatjaNeural'; // Standard neural voice for German
    case 'ja':
      return 'ja-JP-NanamiNeural'; // Standard neural voice for Japanese
    case 'ru':
      return 'ru-RU-SvetlanaNeural'; // Standard neural voice for Russian
    case 'pt':
      return 'pt-BR-FranciscaNeural'; // Standard neural voice for Portuguese
    case 'it':
      return 'it-IT-IsabellaNeural'; // Standard neural voice for Italian
    case 'ko':
      return 'ko-KR-SunHiNeural'; // Neural voice for Korean
    case 'ar':
      return 'ar-SA-ZariyahNeural'; // Neural voice for Arabic
    default:
      console.log(`Unknown language: ${baseLanguage}, defaulting to English voice`);
      return 'en-US-JennyNeural'; // Default to English Jenny
  }
}

export async function POST(req: NextRequest) {
  try {
    // Verify environment variables are set
    if (!process.env.NEXT_PUBLIC_AZURE_TTS_KEY || !process.env.NEXT_PUBLIC_AZURE_TTS_ENDPOINT) {
      console.error('TTS API - Missing environment variables:', {
        key: !!process.env.NEXT_PUBLIC_AZURE_TTS_KEY,
        endpoint: !!process.env.NEXT_PUBLIC_AZURE_TTS_ENDPOINT
      });
      return NextResponse.json(
        { error: 'Server configuration error: TTS credentials not found' },
        { status: 500 }
      );
    }

    const body = await req.json();
    const { text, voice, rate, pitch, language } = body;

    console.log('TTS API request received:', {
      textLength: text?.length || 0,
      language,
      requestedVoice: voice
    });

    if (!text) {
      return NextResponse.json(
        { error: 'Text is required' },
        { status: 400 }
      );
    }

    // Use provided voice or get appropriate voice based on language
    const ttsVoice = voice || getShimmerVoiceForLanguage(language || 'en-US');
    
    console.log(`Selected voice: ${ttsVoice} for language: ${language || 'en-US'}`);
    
    try {
      // Call the TTS function
      console.log(`Calling textToSpeech with parameters:`, {
        textLength: text.length,
        voice: ttsVoice,
        rate: rate || 1,
        pitch: pitch || 0,
        language: language || 'en-US'
      });
      
      const audioData = await textToSpeech({
        text,
        voice: ttsVoice,
        rate,
        pitch,
        language: language || 'en-US',
      });

      if (!audioData || audioData.byteLength === 0) {
        console.error('TTS API received empty audio data');
        return NextResponse.json(
          { error: 'Empty audio data received from TTS service' },
          { status: 500 }
        );
      }

      console.log(`TTS API successfully generated audio: ${audioData.byteLength} bytes`);
      
      // Return the audio data with appropriate headers
      return new NextResponse(audioData, {
        headers: {
          'Content-Type': 'audio/mp3',
          'Content-Length': audioData.byteLength.toString(),
        },
      });
    } catch (error: any) {
      console.error('Error calling textToSpeech function:', error);
      return NextResponse.json(
        { error: `TTS engine error: ${error.message || 'Unknown TTS error'}` },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error('TTS API error:', error.message, error.stack);
    return NextResponse.json(
      { error: error.message || 'Error processing text-to-speech request' },
      { status: 500 }
    );
  }
}

// GET endpoint for health check
export function GET() {
  // Check if environment variables are set
  const envCheck = {
    ttsKey: !!process.env.NEXT_PUBLIC_AZURE_TTS_KEY,
    ttsEndpoint: !!process.env.NEXT_PUBLIC_AZURE_TTS_ENDPOINT
  };
  
  return NextResponse.json({ 
    status: 'TTS service is running',
    environmentVariables: envCheck
  });
} 