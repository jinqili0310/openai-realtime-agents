/**
 * Azure Text-to-Speech service
 * Uses Azure Cognitive Services Speech API to convert text to speech
 */

// Types for TTS
interface TTSOptions {
  text: string;
  voice?: string;
  rate?: number;
  pitch?: number;
  language?: string;
}

/**
 * Convert text to speech using Azure TTS service
 * @param options Options for text-to-speech conversion
 * @returns ArrayBuffer of audio data
 */
export async function textToSpeech(options: TTSOptions): Promise<ArrayBuffer> {
  const { 
    text, 
    voice = 'en-US-JennyNeural', // Default to Jenny (more widely available than Shimmer)
    rate = 1, 
    pitch = 0,
    language = 'en-US'
  } = options;

  console.log(`TTS Request for: "${text.substring(0, 30)}..." with voice ${voice} in language ${language}`);

  // Get Azure TTS credentials from environment variables
  const subscriptionKey = process.env.NEXT_PUBLIC_AZURE_TTS_KEY;
  const endpoint = process.env.NEXT_PUBLIC_AZURE_TTS_ENDPOINT;

  if (!subscriptionKey || !endpoint) {
    console.error('Azure TTS credentials not configured:', { 
      keyExists: !!subscriptionKey, 
      endpointExists: !!endpoint 
    });
    throw new Error('Azure TTS credentials not configured. Please check your environment variables.');
  }

  // Determine the SSML language (use the voice language code by default)
  const ssmlLang = voice.split('-').slice(0, 2).join('-') || language;

  // Format the SSML for Azure TTS
  const ssml = `
    <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${ssmlLang}">
      <voice name="${voice}">
        <prosody rate="${rate}" pitch="${pitch}%">
          ${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')}
        </prosody>
      </voice>
    </speak>
  `;

  try {
    console.log(`Calling Azure TTS API at: ${endpoint} with voice: ${voice}`);
    // Call Azure TTS API
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': subscriptionKey,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
        'User-Agent': 'OpenAI-Realtime-Agents-TTS'
      },
      body: ssml
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Azure TTS API error: ${response.status}`, {
        error: errorText,
        usedVoice: voice,
        ssmlLanguage: ssmlLang
      });
      throw new Error(`Azure TTS API returned error: ${response.status} - ${errorText}`);
    }

    console.log('Azure TTS API call successful, returning audio data');
    // Return the audio data as ArrayBuffer
    return await response.arrayBuffer();
  } catch (error) {
    console.error('Error in Azure TTS service:', error);
    throw error;
  }
}

/**
 * Play TTS audio in the browser
 * @param audioData ArrayBuffer of audio data
 */
export function playTTSAudio(audioData: ArrayBuffer): void {
  // Create a blob from the audio data
  const blob = new Blob([audioData], { type: 'audio/mp3' });
  const url = URL.createObjectURL(blob);
  
  // Create and play audio element
  const audio = new Audio(url);
  
  // Clean up the URL object when done
  audio.onended = () => {
    URL.revokeObjectURL(url);
  };
  
  // Play the audio
  audio.play().catch(error => {
    console.error('Error playing TTS audio:', error);
  });
} 