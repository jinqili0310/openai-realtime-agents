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
    
    // 配置 - 修改以适应停顿
    webRecognizer.continuous = true; // 启用连续识别
    webRecognizer.interimResults = true; // 获取中间结果
    webRecognizer.lang = 'zh-CN'; 
    webRecognizer.maxAlternatives = 1;
    
    // 停顿处理相关变量
    let restartTimeout: any = null;
    let lastResultTimestamp = Date.now();
    const PAUSE_THRESHOLD = 2000; // 2秒停顿阈值
    let isPaused = false;
    
    // 存储到全局变量
    (window as any).webRecognizer = webRecognizer;
    (window as any).speechRecognitionState = {
      restartTimeout,
      lastResultTimestamp,
      isPaused,
      lastTranscript: '',
      isRecognitionActive: false,
      isAttemptingRestart: false,
      manualStopped: false
    };
    
    // 设置事件
    webRecognizer.onresult = (event: any) => {
      // 更新最后结果时间戳
      lastResultTimestamp = Date.now();
      (window as any).speechRecognitionState.lastResultTimestamp = lastResultTimestamp;
      
      // 标记识别为活动状态
      (window as any).speechRecognitionState.isRecognitionActive = true;
      
      // 如果有暂停重启计时器，清除它
      if (restartTimeout) {
        clearTimeout(restartTimeout);
        restartTimeout = null;
      }
      
      let interimTranscript = '';
      let finalTranscript = '';
      
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript;
          
          // 保存最后的转写结果
          (window as any).speechRecognitionState.lastTranscript = finalTranscript;
          
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
      
      // 设置停顿检测器 - 如果用户停顿太久，自动重启识别器
      setAutoPauseDetector();
    };
    
    // 添加停顿自动重启功能
    const setAutoPauseDetector = () => {
      // 清除现有的超时
      if (restartTimeout) {
        clearTimeout(restartTimeout);
      }
      
      // 如果已经在监听中，设置新的超时
      if (isListening) {
        restartTimeout = setTimeout(() => {
          console.log(`检测到停顿(${PAUSE_THRESHOLD}ms)，准备重启识别器...`);
          
          // 检查当前识别状态
          const currentState = (window as any).speechRecognitionState || {};
          const recognitionActive = currentState.isRecognitionActive || false;
          
          try {
            // 只有在确认识别器已停止的情况下才尝试停止
            if (recognitionActive) {
              console.log('当前识别器仍在活动中，无需重启');
              // 更新时间戳以防止频繁检测
              (window as any).speechRecognitionState.lastResultTimestamp = Date.now();
              return;
            }
            
            // 只在识别器实际已停止的情况下进行重启
            console.log('识别器已停止，尝试重启...');
            
            // 尝试优雅地停止然后重启
            try {
              (window as any).webRecognizer.stop();
              console.log('语音识别器已停止，准备重启');
            } catch (stopError) {
              // 如果停止失败，可能已经停止，继续尝试重启
              console.log('停止识别器可能失败或已经停止:', stopError);
            }
            
            // 短延迟后重启
            setTimeout(() => {
              try {
                // 再次检查是否真的需要重启
                if (!(window as any).speechRecognitionState.isRecognitionActive && !currentState.manualStopped) {
                  console.log('尝试重启语音识别器...');
                  
                  // 设置状态为正在尝试启动
                  (window as any).speechRecognitionState.isAttemptingRestart = true;
                  
                  (window as any).webRecognizer.start();
                  console.log('语音识别器已重启');
                  
                  // 标记识别为活动状态
                  (window as any).speechRecognitionState.isRecognitionActive = true;
                  
                  // 更新时间戳
                  (window as any).speechRecognitionState.lastResultTimestamp = Date.now();
                  
                  // 清除尝试重启标志
                  setTimeout(() => {
                    (window as any).speechRecognitionState.isAttemptingRestart = false;
                  }, 500);
                  
                  // 恢复上次的转写结果
                  if ((window as any).speechRecognitionState.lastTranscript) {
                    console.log('恢复上次转写结果:', (window as any).speechRecognitionState.lastTranscript);
                    // 恢复上次的转写结果到UI
                    onTranscriptionCallback({
                      text: (window as any).speechRecognitionState.lastTranscript,
                      language: 'zh-CN',
                      isFinal: true
                    });
                  }
                } else {
                  console.log('识别器已经在活动中或已手动停止，跳过重启');
                }
              } catch (err) {
                console.error('重启语音识别器失败:', err);
                // 重置识别状态
                (window as any).speechRecognitionState.isRecognitionActive = false;
                (window as any).speechRecognitionState.isAttemptingRestart = false;
                isListening = false;
              }
            }, 500);
            
          } catch (err) {
            console.error('停止语音识别器失败:', err);
            // 重置识别状态
            (window as any).speechRecognitionState.isRecognitionActive = false;
          }
        }, PAUSE_THRESHOLD);
        
        // 保存超时引用
        (window as any).speechRecognitionState.restartTimeout = restartTimeout;
      }
    };
    
    // 添加各种错误处理
    webRecognizer.onerror = (event: any) => {
      console.error('Web Speech API错误:', event.error);
      
      // 对于特定错误，尝试自动重启
      if (event.error === 'no-speech' || event.error === 'network') {
        console.log('检测到可恢复错误，尝试重启语音识别...');
        try {
          setTimeout(() => {
            if (isListening) {
              try {
                (window as any).webRecognizer.stop();
                setTimeout(() => {
                  (window as any).webRecognizer.start();
                  console.log('语音识别已自动恢复');
                }, 500);
              } catch (e) {
                console.error('自动恢复语音识别失败:', e);
              }
            }
          }, 1000);
        } catch (err) {
          console.error('自动重启语音识别失败:', err);
        }
      }
    };
    
    // 添加开始事件处理
    webRecognizer.onstart = () => {
      console.log('Web Speech API识别已开始');
      (window as any).speechRecognitionState.isRecognitionActive = true;
      isListening = true;
    };
    
    // 添加结束事件处理
    webRecognizer.onend = () => {
      console.log('Web Speech识别结束事件被触发');
      
      // 标记识别为非活动状态
      (window as any).speechRecognitionState.isRecognitionActive = false;
      
      // 如果仍处于监听状态且未手动停止，尝试自动重启
      // 但是要检查是否正在尝试重启中以避免重复启动
      if (isListening && 
          !(window as any).manualStopped && 
          !(window as any).speechRecognitionState.isAttemptingRestart) {
        
        console.log('语音识别意外结束，尝试自动重启...');
        
        // 设置状态为正在尝试重启
        (window as any).speechRecognitionState.isAttemptingRestart = true;
        
        setTimeout(() => {
          try {
            // 再次检查状态
            if (!((window as any).speechRecognitionState.isRecognitionActive)) {
              (window as any).webRecognizer.start();
              console.log('语音识别已自动重启');
              (window as any).speechRecognitionState.isRecognitionActive = true;
            } else {
              console.log('识别器已经在活动中，跳过重启');
            }
          } catch (err) {
            console.error('自动重启语音识别失败:', err);
            (window as any).speechRecognitionState.isRecognitionActive = false;
            isListening = false;
          } finally {
            // 清除尝试重启标志
            (window as any).speechRecognitionState.isAttemptingRestart = false;
          }
        }, 500);
      }
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
      
      // 给一些时间让之前的识别完全停止
      setTimeout(() => {
        startRecognitionInternal(targetLanguage);
      }, 300);
    } else {
      startRecognitionInternal(targetLanguage);
    }
  } catch (error) {
    console.error('启动语音识别失败:', error);
  }
}

// 内部启动函数
function startRecognitionInternal(targetLanguage: string) {
  // 检查Web Speech API
  if ((window as any).webRecognizer) {
    console.log('使用Web Speech API开始识别');
    try {
      // 检查识别器当前是否已经在活动中
      if ((window as any).speechRecognitionState.isRecognitionActive) {
        console.log('识别器已经在活动中，不需要重新启动');
        isListening = true;
        return;
      }
      
      // 重置手动停止标志
      (window as any).manualStopped = false;
      (window as any).speechRecognitionState.manualStopped = false;
      
      // 清空之前的转写记录
      (window as any).speechRecognitionState.lastTranscript = '';
      
      // 设置状态为正在尝试启动
      (window as any).speechRecognitionState.isAttemptingRestart = true;
      
      // 启动识别
      (window as any).webRecognizer.start();
      isListening = true;
      
      console.log('Web Speech API识别已启动');
      
      // 清除尝试启动标志
      setTimeout(() => {
        (window as any).speechRecognitionState.isAttemptingRestart = false;
      }, 500);
    } catch (webSpeechError: any) {
      console.error('启动Web Speech识别失败:', webSpeechError);
      
      // 如果错误是因为识别已经开始，则更新状态
      if (webSpeechError.toString && webSpeechError.toString().includes('recognition has already started')) {
        console.log('识别已经开始，更新状态');
        (window as any).speechRecognitionState.isRecognitionActive = true;
        isListening = true;
      }
      
      // 清除尝试启动标志
      (window as any).speechRecognitionState.isAttemptingRestart = false;
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
        // 设置手动停止标志，防止自动重启
        (window as any).manualStopped = true;
        (window as any).speechRecognitionState.manualStopped = true;
        
        // 清除任何可能存在的重启定时器
        if ((window as any).speechRecognitionState && 
            (window as any).speechRecognitionState.restartTimeout) {
          clearTimeout((window as any).speechRecognitionState.restartTimeout);
          (window as any).speechRecognitionState.restartTimeout = null;
        }
        
        // 检查当前是否真的在运行
        if ((window as any).speechRecognitionState.isRecognitionActive) {
          // 停止识别
          (window as any).webRecognizer.stop();
          console.log('Web Speech API识别已手动停止');
        } else {
          console.log('Web Speech API识别器已经是停止状态');
        }
        
        // 更新状态
        (window as any).speechRecognitionState.isRecognitionActive = false;
        isListening = false;
      } catch (webSpeechError: any) {
        console.error('停止Web Speech识别失败:', webSpeechError);
        
        // 确保状态更新
        (window as any).speechRecognitionState.isRecognitionActive = false;
        isListening = false;
      }
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