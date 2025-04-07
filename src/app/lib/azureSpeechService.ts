import { RefObject } from 'react';

// Azure Speech SDK types (these will be imported from the SDK when installed)
interface AzureSpeechRecognitionResult {
  text: string;
  language: string;
  isFinal: boolean;
}

interface AzureTranslationResult {
  originalText: string;
  translatedText: string;
  fromLanguage: string;
  toLanguage: string;
  isFinal: boolean;
}

// Callback types
type TranscriptionCallback = (result: AzureSpeechRecognitionResult) => void;
type TranslationCallback = (result: AzureTranslationResult) => void;

let recognizer: any = null;
let translator: any = null;
let speechConfig: any = null;
let audioConfig: any = null;
let isInitialized = false;
let isListening = false;

// 定义一个备用区域列表，如果主要区域连接失败可以尝试这些
const fallbackRegions = ['eastus', 'eastus2', 'westus2', 'southeastasia', 'westeurope'];
let currentRegionIndex = 0;

// 存储回调函数的引用
let onTranscriptionCallback: TranscriptionCallback = (result) => console.log('默认转写回调:', result);
let onTranslationCallback: TranslationCallback = (result) => console.log('默认翻译回调:', result);

// 存储转写文本，用于实时翻译
let currentTranscript = '';

// 初始化Azure服务
export async function initAzureSpeechService(onTranscription: TranscriptionCallback, onTranslation: TranslationCallback): Promise<boolean> {
  // 保存回调函数引用
  onTranscriptionCallback = onTranscription;
  onTranslationCallback = onTranslation;
  
  try {
    console.log('正在初始化语音服务...');
    
    // 检查浏览器Web Speech API支持
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      console.log('浏览器支持Web Speech API，使用浏览器原生语音识别');
      
      // 使用浏览器原生语音识别API作为备用
      await initWebSpeechRecognition();
      return true;
    } else {
      console.log('浏览器不支持Web Speech API，尝试使用Azure服务');
      
      // 尝试使用Azure服务
      try {
        // 动态导入Azure Speech SDK
        const { SpeechConfig, AudioConfig, SpeechRecognizer, TranslationRecognizer, ResultReason } = await import('microsoft-cognitiveservices-speech-sdk');
        
        // 获取API密钥
        const subscriptionKey = process.env.NEXT_PUBLIC_AZURE_TTS_KEY;
        
        // 使用备用区域列表中的当前区域
        const region = fallbackRegions[currentRegionIndex];
        
        console.log('Azure Speech Key:', subscriptionKey ? '已配置' : '未配置');
        console.log('尝试使用区域:', region);
        
        if (!subscriptionKey) {
          console.error('Azure语音API密钥未配置，回退到Web Speech API');
          await initWebSpeechRecognition();
          return true;
        }
        
        // 创建语音配置
        try {
          console.log('尝试创建Azure语音配置...');
          speechConfig = SpeechConfig.fromSubscription(subscriptionKey, region);
          
          // 设置语言
          speechConfig.speechRecognitionLanguage = 'zh-CN';
          
          // 创建音频配置
          audioConfig = AudioConfig.fromDefaultMicrophoneInput();
          
          // 创建语音识别器
          recognizer = new SpeechRecognizer(speechConfig, audioConfig);
          
          // 设置事件处理
          setupAzureRecognizerEvents(recognizer, ResultReason);
          
          // 启动语音识别
          try {
            await new Promise((resolve, reject) => {
              recognizer.startContinuousRecognitionAsync(
                () => {
                  console.log('Azure语音识别器启动成功');
                  resolve(true);
                },
                (err: Error) => {
                  console.error('Azure语音识别器启动失败:', err);
                  reject(err);
                }
              );
            });
            
            isInitialized = true;
            console.log('Azure语音服务初始化成功');
            return true;
          } catch (startError) {
            console.error('启动Azure语音识别器失败，回退到Web Speech API:', startError);
            await initWebSpeechRecognition();
            return true;
          }
        } catch (configError) {
          console.error('创建Azure语音配置失败，回退到Web Speech API:', configError);
          await initWebSpeechRecognition();
          return true;
        }
      } catch (azureError) {
        console.error('加载Azure语音SDK失败，回退到Web Speech API:', azureError);
        await initWebSpeechRecognition();
        return true;
      }
    }
  } catch (error) {
    console.error('语音服务初始化失败:', error);
    return false;
  }
}

// 设置Azure识别器事件
function setupAzureRecognizerEvents(recognizer: any, ResultReason: any) {
  // 设置识别事件
  recognizer.recognized = (s: any, e: any) => {
    console.log('Azure识别完成事件:', e.result);
    if (e.result.reason === ResultReason.RecognizedSpeech) {
      console.log('识别到最终文本:', e.result.text);
      onTranscriptionCallback({
        text: e.result.text,
        language: e.result.language || 'zh-CN',
        isFinal: true
      });
    }
  };
  
  recognizer.recognizing = (s: any, e: any) => {
    console.log('Azure识别中事件:', e.result.text);
    if (e.result.text) {
      onTranscriptionCallback({
        text: e.result.text,
        language: e.result.language || 'zh-CN',
        isFinal: false
      });
    }
  };
  
  // 设置错误处理
  recognizer.canceled = (s: any, e: any) => {
    console.log('Azure识别被取消:', e.reason, e.errorDetails);
  };
}

// 用于实时翻译的全局变量
let currentTargetLanguage = 'en-US';
let translationTimeout: any = null;

// 实时翻译文本函数
async function translateText(text: string, isFinal: boolean) {
  if (!text.trim()) return;
  
  // 清除之前的翻译请求
  if (translationTimeout) {
    clearTimeout(translationTimeout);
  }
  
  // 如果是中间结果，添加短延迟避免频繁请求
  if (!isFinal) {
    translationTimeout = setTimeout(() => performTranslation(text, isFinal), 500);
  } else {
    // 对于最终结果，立即翻译
    performTranslation(text, isFinal);
  }
}

// 执行翻译请求
async function performTranslation(text: string, isFinal: boolean) {
  try {
    // 确定目标语言代码 (简单形式)
    const targetLang = currentTargetLanguage.split('-')[0]; // 从 "en-US" 提取 "en"
    
    console.log(`尝试翻译文本到 ${targetLang}: ${text.substring(0, 30)}${text.length > 30 ? '...' : ''}`);
    
    // 使用本地API进行翻译
    const response = await fetch('/api/translate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text,
        targetLanguage: targetLang
      }),
    });
    
    if (response.ok) {
      const data = await response.json();
      
      // 调用翻译回调
      onTranslationCallback({
        originalText: text,
        translatedText: data.translatedText,
        fromLanguage: data.detectedLanguage || 'zh-CN',
        toLanguage: targetLang,
        isFinal: isFinal
      });
      
      console.log(`翻译成功: ${data.translatedText.substring(0, 30)}${data.translatedText.length > 30 ? '...' : ''}`);
    } else {
      console.error('翻译请求失败:', await response.text());
    }
  } catch (error) {
    console.error('翻译过程中出错:', error);
  }
}

// 初始化Web Speech API
async function initWebSpeechRecognition(): Promise<boolean> {
  try {
    console.log('初始化Web Speech API...');
    
    // 使用浏览器Web Speech API
    const SpeechRecognition = (window as any).SpeechRecognition || 
                             (window as any).webkitSpeechRecognition;
    
    if (!SpeechRecognition) {
      console.error('浏览器不支持Web Speech API');
      return false;
    }
    
    // 创建识别器
    const webRecognizer = new SpeechRecognition();
    
    // 配置
    webRecognizer.continuous = true;
    webRecognizer.interimResults = true;
    webRecognizer.lang = 'zh-CN';
    
    // 存储到全局变量
    (window as any).webRecognizer = webRecognizer;
    
    // 设置事件
    webRecognizer.onresult = (event: any) => {
      let interimTranscript = '';
      let finalTranscript = '';
      
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript;
          
          // 发送最终结果
          onTranscriptionCallback({
            text: finalTranscript,
            language: 'zh-CN',
            isFinal: true
          });
          
          // 保存当前转写文本
          currentTranscript = finalTranscript;
          
          // 处理最终翻译
          translateText(finalTranscript, true);
        } else {
          interimTranscript += transcript;
          
          // 保存当前转写文本
          currentTranscript = interimTranscript;
          
          // 发送中间结果
          onTranscriptionCallback({
            text: interimTranscript,
            language: 'zh-CN',
            isFinal: false
          });
          
          // 处理实时翻译
          translateText(interimTranscript, false);
        }
      }
    };
    
    webRecognizer.onerror = (event: any) => {
      console.error('Web Speech API错误:', event.error);
    };
    
    // 设置成功标志
    isInitialized = true;
    console.log('Web Speech API初始化成功');
    return true;
  } catch (error) {
    console.error('初始化Web Speech API失败:', error);
    return false;
  }
}

// 开始语音识别和翻译 - 修改为支持Web Speech API
export function startAzureSpeechRecognition(targetLanguage: string = 'en-US') {
  if (!isInitialized) {
    console.error('语音服务未初始化，无法启动识别');
    return;
  }
  
  // 更新当前目标语言
  currentTargetLanguage = targetLanguage;
  
  try {
    console.log(`开始语音识别，目标语言: ${targetLanguage}`);
    
    // 确保之前的识别已停止
    if (isListening) {
      stopAzureSpeechRecognition();
    }
    
    // 检查Web Speech API
    if ((window as any).webRecognizer) {
      console.log('使用Web Speech API开始识别');
      try {
        (window as any).webRecognizer.start();
        isListening = true;
        
        // 翻译不能在Web Speech API中直接实现，可以通过OpenAI处理
        console.log('Web Speech API不支持实时翻译，将由OpenAI处理最终翻译');
      } catch (webSpeechError) {
        console.error('启动Web Speech识别失败:', webSpeechError);
      }
      return;
    }
    
    // 使用Azure服务
    if (recognizer) {
      console.log('使用Azure语音服务开始识别');
      recognizer.startContinuousRecognitionAsync(
        () => {
          console.log('Azure实时转写已启动');
          isListening = true;
        },
        (err: Error) => console.error('启动Azure实时转写失败:', err)
      );
    }
  } catch (error) {
    console.error('启动语音识别失败:', error);
  }
}

// 停止语音识别和翻译 - 修改为支持Web Speech API
export function stopAzureSpeechRecognition() {
  if (!isInitialized) {
    return;
  }
  
  try {
    console.log('停止语音识别');
    
    // 检查Web Speech API
    if ((window as any).webRecognizer) {
      console.log('停止Web Speech API识别');
      try {
        (window as any).webRecognizer.stop();
      } catch (webSpeechError) {
        console.error('停止Web Speech识别失败:', webSpeechError);
      }
      isListening = false;
      return;
    }
    
    // 使用Azure服务
    if (recognizer) {
      recognizer.stopContinuousRecognitionAsync(
        () => {
          console.log('Azure实时转写已停止');
          isListening = false;
        },
        (err: Error) => console.error('停止Azure实时转写失败:', err)
      );
    }
  } catch (error) {
    console.error('停止语音识别失败:', error);
    isListening = false;
  }
}

// 更新翻译目标语言
export function updateTargetLanguage(targetLanguage: string) {
  if (!isInitialized || !translator) {
    return;
  }
  
  try {
    console.log(`更新翻译目标语言: ${targetLanguage}`);
    
    // 需要先停止当前翻译
    if (isListening) {
      translator.stopContinuousRecognitionAsync();
      
      // 更新目标语言
      translator.targetLanguages = [targetLanguage];
      
      // 重新启动翻译
      translator.startContinuousRecognitionAsync();
    } else {
      // 如果未运行，只更新语言配置
      translator.targetLanguages = [targetLanguage];
    }
  } catch (error) {
    console.error('更新翻译目标语言失败:', error);
  }
}

// 释放资源
export function disposeAzureSpeechService() {
  try {
    if (recognizer) {
      recognizer.stopContinuousRecognitionAsync();
      recognizer.close();
      recognizer = null;
    }
    
    if (translator) {
      translator.stopContinuousRecognitionAsync();
      translator.close();
      translator = null;
    }
    
    if (speechConfig) {
      speechConfig.close();
      speechConfig = null;
    }
    
    if (audioConfig) {
      audioConfig.close();
      audioConfig = null;
    }
    
    isInitialized = false;
    isListening = false;
    console.log('Azure语音服务资源已释放');
  } catch (error) {
    console.error('释放Azure语音服务资源失败:', error);
  }
} 