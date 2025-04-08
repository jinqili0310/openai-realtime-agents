"use client";

import { ServerEvent, SessionStatus, AgentConfig } from "@/app/types";
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useRef } from "react";

export interface UseHandleServerEventParams {
  setSessionStatus: (status: SessionStatus) => void;
  selectedAgentName: string;
  selectedAgentConfigSet: AgentConfig[] | null;
  sendClientEvent: (eventObj: any, eventNameSuffix?: string) => void;
  setSelectedAgentName: (name: string) => void;
  setMainLang?: (lang: string) => void;
  setLastTargetLang?: (lang: string) => void;
  isFirstMessage?: boolean;
  setIsFirstMessage?: (value: boolean) => void;
  mainLang?: string;
  lastTargetLang?: string;
  shouldForceResponse?: boolean;
  updateTranscriptMessage?: (itemId: string, content: string, shouldProcess: boolean) => void;
  updateTranscriptItemStatus?: (itemId: string, status: "PENDING" | "IN_PROGRESS" | "DONE" | "ERROR") => void;
}

export function useHandleServerEvent({
  setSessionStatus,
  selectedAgentName,
  selectedAgentConfigSet,
  sendClientEvent,
  setSelectedAgentName,
  setMainLang,
  setLastTargetLang,
  isFirstMessage,
  setIsFirstMessage,
  mainLang,
  lastTargetLang,
  updateTranscriptMessage: externalUpdateTranscriptMessage,
  updateTranscriptItemStatus: externalUpdateTranscriptItemStatus,
}: UseHandleServerEventParams) {
  const {
    transcriptItems,
    addTranscriptBreadcrumb,
    addTranscriptMessage,
    updateTranscriptMessage,
    updateTranscriptItemStatus,
  } = useTranscript();

  const { logServerEvent } = useEvent();

  const handleFunctionCall = async (functionCallParams: {
    name: string;
    call_id?: string;
    arguments: string;
  }) => {
    const args = JSON.parse(functionCallParams.arguments);
    const currentAgent = selectedAgentConfigSet?.find(
      (a) => a.name === selectedAgentName
    );

    addTranscriptBreadcrumb(`function call: ${functionCallParams.name}`, args);

    if (currentAgent?.toolLogic?.[functionCallParams.name]) {
      const fn = currentAgent.toolLogic[functionCallParams.name];
      const fnResult = await fn(args, transcriptItems);
      addTranscriptBreadcrumb(
        `function call result: ${functionCallParams.name}`,
        fnResult
      );

      sendClientEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallParams.call_id,
          output: JSON.stringify(fnResult),
        },
      });
      sendClientEvent({ type: "response.create" });
    } else if (functionCallParams.name === "transferAgents") {
      const destinationAgent = args.destination_agent;
      const newAgentConfig =
        selectedAgentConfigSet?.find((a) => a.name === destinationAgent) || null;
      if (newAgentConfig) {
        setSelectedAgentName(destinationAgent);
      }
      const functionCallOutput = {
        destination_agent: destinationAgent,
        did_transfer: !!newAgentConfig,
      };
      sendClientEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallParams.call_id,
          output: JSON.stringify(functionCallOutput),
        },
      });
      addTranscriptBreadcrumb(
        `function call: ${functionCallParams.name} response`,
        functionCallOutput
      );
    } else {
      const simulatedResult = { result: true };
      addTranscriptBreadcrumb(
        `function call fallback: ${functionCallParams.name}`,
        simulatedResult
      );

      sendClientEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallParams.call_id,
          output: JSON.stringify(simulatedResult),
        },
      });
      sendClientEvent({ type: "response.create" });
    }
  };

  const handleServerEvent = (serverEvent: ServerEvent) => {
    logServerEvent(serverEvent);

    // 处理错误消息
    if (serverEvent.type === "error") {
      console.error("服务器事件错误:", serverEvent);
      
      // 显示错误信息给用户
      addTranscriptBreadcrumb(`API错误: ${serverEvent.error?.message || '未知错误'}`);
      
      // 如果是ITEM_ID错误，记录更多信息
      if (serverEvent.error?.code === "item_truncate_invalid_item_id") {
        console.warn("无效的item_id错误:", serverEvent.error.message);
      }
      
      return;
    }

    // 处理OpenAI实时转写回复和更新实时消息 - 修复事件类型匹配
    if (
      (serverEvent.type === "conversation.item.created" || 
       serverEvent.type === "conversation.item.updated" ||
       serverEvent.type === "response.audio_transcript.delta" ||
       serverEvent.type === "response.output_item.done") &&
      serverEvent.item?.role === "assistant" &&
      typeof window !== "undefined" &&
      window.lastTranslationId && 
      window.lastTranscriptId
    ) {
      // 从事件中提取文本内容
      const assistantText = serverEvent.item.content?.find(c => c.type === "text")?.text || "";
      
      console.log("收到助手回复，准备更新实时翻译消息:", assistantText);
      
      if (assistantText && externalUpdateTranscriptMessage && externalUpdateTranscriptItemStatus) {
        // 更新翻译消息为助手的响应
        externalUpdateTranscriptMessage(window.lastTranslationId, assistantText, false);
        externalUpdateTranscriptItemStatus(window.lastTranslationId, "DONE");
        
        // 更新转写消息内容并设为完成状态
        externalUpdateTranscriptMessage(window.lastTranscriptId, 
          transcriptItems.find(item => item.itemId === window.lastTranscriptId)?.title || "", 
          false);
        externalUpdateTranscriptItemStatus(window.lastTranscriptId, "DONE");
        
        console.log("已更新实时消息为最终结果");
        
        // 完成处理后清除引用
        window.lastTranslationId = null;
        window.lastTranscriptId = null;
        
        // 如果是'created'事件，跳过后续处理
        if (serverEvent.type === "conversation.item.created") {
          return;
        }
      }
    }

    // 处理特定的转写完成和增量更新事件
    if (typeof window !== "undefined" && window.lastTranscriptId && window.lastTranslationId) {
      // 处理增量更新
      if (serverEvent.type === "response.audio_transcript.delta" && serverEvent.delta) {
        console.log("处理增量更新:", serverEvent.delta);
        if (externalUpdateTranscriptMessage && window.lastTranslationId) {
          externalUpdateTranscriptMessage(window.lastTranslationId, serverEvent.delta, true);
        }
      }
      
      // 处理转写完成事件
      if (serverEvent.type === "conversation.item.input_audio_transcription.completed" && 
          serverEvent.transcript && 
          serverEvent.item_id === window.lastTranscriptId) {
        console.log("处理转写完成:", serverEvent.transcript);
        if (externalUpdateTranscriptMessage) {
          // 更新用户转写内容
          externalUpdateTranscriptMessage(window.lastTranscriptId, serverEvent.transcript, false);
        }
      }
    }

    switch (serverEvent.type) {
      case "session.created": {
        if (serverEvent.session?.id) {
          setSessionStatus("CONNECTED");
          addTranscriptBreadcrumb(
            `session.id: ${
              serverEvent.session.id
            }\nStarted at: ${new Date().toLocaleString()}`
          );
        }
        break;
      }

      case "conversation.item.created": {
        let text =
          serverEvent.item?.content?.[0]?.text ||
          serverEvent.item?.content?.[0]?.transcript ||
          "";
        const role = serverEvent.item?.role as "user" | "assistant";
        const itemId = serverEvent.item?.id;

        // 验证item_id是否有效
        if (!itemId || itemId.length < 10) {
          console.warn("收到无效的item_id:", itemId);
          break;
        }

        if (itemId && transcriptItems.some((item) => item.itemId === itemId)) {
          console.log("item_id已存在，跳过:", itemId);
          break;
        }

        // 检查是否为空消息并且用户已经有实时消息ID
        if (role === "assistant" && (!text || text.trim() === "") && 
            typeof window !== "undefined" && window.lastTranscriptId) {
          console.log("跳过创建无内容的助手消息");
          break;
        }

        if (itemId && role) {
          if (role === "user" && !text) {
            text = "[Transcribing...]";
          }
          addTranscriptMessage(itemId, role, text);
        }
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const itemId = serverEvent.item_id;
        console.log("Received conversation.item.input_audio_transcription.completed event:", { itemId, event: serverEvent });
        const finalTranscript =
          !serverEvent.transcript || serverEvent.transcript === "\n"
            ? "[inaudible]"
            : serverEvent.transcript;
        if (itemId) {
          console.log("Updating transcript message for itemId:", itemId);
          updateTranscriptMessage(itemId, finalTranscript, false);
          
          // 处理语言检测
          if (finalTranscript !== "[inaudible]" && setMainLang && setLastTargetLang) {
            detectLanguage(finalTranscript).then(detectedLang => {
              if (detectedLang !== "unknown") {
                console.log(`Processing language detection: ${detectedLang}, First message: ${isFirstMessage}`);
                
                // 使用新的语言状态更新函数
                updateLanguageState(
                  detectedLang,
                  isFirstMessage,
                  setMainLang,
                  setLastTargetLang,
                  setIsFirstMessage,
                  mainLang,
                  lastTargetLang
                );
              }
            });
          }
        }
        break;
      }

      case "response.audio_transcript.delta": {
        const itemId = serverEvent.item_id;
        const deltaText = serverEvent.delta || "";
        if (itemId) {
          updateTranscriptMessage(itemId, deltaText, true);
        }
        break;
      }

      case "response.done": {
        if (serverEvent.response?.output) {
          serverEvent.response.output.forEach((outputItem) => {
            if (
              outputItem.type === "function_call" &&
              outputItem.name &&
              outputItem.arguments
            ) {
              handleFunctionCall({
                name: outputItem.name,
                call_id: outputItem.call_id,
                arguments: outputItem.arguments,
              });
            }
          });
        }
        break;
      }

      case "response.output_item.done": {
        const itemId = serverEvent.item?.id;
        console.log("Received response.output_item.done event:", { itemId, event: serverEvent });
        
        if (itemId) {
          // 获取消息内容
          const content = serverEvent.item?.content?.[0]?.text || "";
          console.log("Updating transcript message with content:", content);
          
          // 更新消息内容
          if (externalUpdateTranscriptMessage) {
            externalUpdateTranscriptMessage(itemId, content, false);
          }
          
          // 更新消息状态为完成
          console.log("Updating transcript item status to DONE for itemId:", itemId);
          updateTranscriptItemStatus(itemId, "DONE");
          
          // 如果是助手消息，发送到父窗口以显示翻译结果
          if (serverEvent.item?.role === "assistant") {
            console.log("Sending translation result to parent window");
            window.parent.postMessage({
              type: "translation",
              role: "assistant",
              content: content
            }, "*");
          }
        }
        break;
      }

      // 处理其他可能引起item_id错误的事件
      case "conversation.item.truncate": {
        const itemId = serverEvent.item_id;
        
        // 验证itemId是否存在且有效
        if (!itemId || itemId.length < 10 || !transcriptItems.some(item => item.itemId === itemId)) {
          console.warn("尝试截断不存在的item:", itemId);
          break;
        }
        
        console.log("成功截断消息:", itemId);
        break;
      }

      case "conversation.item.ended": {
        const itemId = serverEvent.item_id;
        console.log("Received conversation.item.ended event:", { itemId, event: serverEvent });
        
        // 验证item是否存在
        if (!itemId || !transcriptItems.some(item => item.itemId === itemId)) {
          console.warn("收到未知item的ended事件:", itemId);
          break;
        }
        
        console.log("Updating transcript item status to DONE for itemId:", itemId);
        updateTranscriptItemStatus(itemId, "DONE");
        break;
      }

      default:
        break;
    }
  };

  const handleServerEventRef = useRef(handleServerEvent);
  handleServerEventRef.current = handleServerEvent;

  return handleServerEventRef;
}

// 使用GPT进行语言检测
const detectLanguageByGPT = async (text: string): Promise<string> => {
  // 如果文本太短或为空，使用基本检测
  if (!text || text.trim().length < 5) {
    return detectBasicLanguage(text);
  }
  
  try {
    // 调用服务器端API进行语言检测
    const response = await fetch('/api/detect-language', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });
    
    if (!response.ok) {
      console.error('Language detection API error:', response.statusText);
      return detectBasicLanguage(text); // 失败时回退到基本检测
    }
    
    const data = await response.json();
    // Use languageCode directly which is now a normalized code (en, zh, es, etc.)
    const detectedLang = data.languageCode || 'unknown';
    console.log(`Language detection API result: ${detectedLang} (${data.languageName || 'Unknown'}) for text: ${text.substring(0, 20)}...`);
    return detectedLang;
  } catch (error) {
    console.error('Error detecting language with GPT:', error);
    return detectBasicLanguage(text); // 出错时回退到基本检测
  }
};

// 基本的语言检测，作为备选方案
const detectBasicLanguage = (text: string): string => {
  try {
    // 基本检测规则 - 返回语言代码而不是名称
    if (/[a-zA-Z]/.test(text)) {
      if (/[ñáéíóúü]/.test(text)) {
        return "es"; 
      } else {
        return "en";
      }
    } else if (/[\u4e00-\u9fa5]/.test(text)) {
      return "zh";
    } else if (/[\u3040-\u30ff]/.test(text)) {
      return "ja";
    } else if (/[\u0400-\u04FF]/.test(text)) {
      return "ru";
    } else if (/[\u0600-\u06FF]/.test(text)) {
      return "ar";
    } else if (/[\u0900-\u097F]/.test(text)) {
      return "hi";
    } else if (/[\u1100-\u11FF\uAC00-\uD7AF]/.test(text)) {
      return "ko";
    } else if (/[\u0E00-\u0E7F]/.test(text)) {
      return "th";
    } else if (/[\u0370-\u03FF]/.test(text)) {
      return "el";
    }
    
    return "unknown";
  } catch (error) {
    console.error("Error in basic language detection:", error);
    return "unknown";
  }
};

// Helper function to detect language (simplified version)
export const detectLanguage = async (text: string): Promise<string> => {
  return detectLanguageByGPT(text);
};

// 添加延迟以确保状态更新
export const updateLanguageState = (
  detected: string, 
  isFirst: boolean | undefined, 
  setML?: (lang: string) => void,
  setTL?: (lang: string) => void,
  setIsFirst?: (val: boolean) => void,
  currML?: string,
  currTL?: string
) => {
  if (!setML || !setTL) return;
  
  // Get normalized language code
  const normalizeLanguage = (lang: string): string => {
    const langMap: Record<string, string> = {
      "Chinese": "zh",
      "English": "en",
      "Spanish": "es",
      "French": "fr",
      "German": "de",
      "Japanese": "ja",
      "Russian": "ru",
      "Korean": "ko",
      "Arabic": "ar",
      "Hindi": "hi",
      "Portuguese": "pt",
      "Italian": "it",
      "Dutch": "nl",
      "Greek": "el",
      "Thai": "th"
    };
    return langMap[lang] || lang.toLowerCase().split('-')[0];
  };
  
  const normalizedDetected = normalizeLanguage(detected);
  const normalizedCurrML = currML ? normalizeLanguage(currML) : "zh"; // Default ML is Chinese
  const normalizedCurrTL = currTL ? normalizeLanguage(currTL) : "en"; // Default TL is English
  
  if (isFirst && setIsFirst) {
    // First message - set main language based on detection, default target to English or Chinese
    console.log(`First language detection: ${detected}, setting as main language`);
    
    // Set the detected language as main language
    setML(normalizedDetected);
    
    // Set target language to English if the detected language is not English,
    // otherwise set it to Chinese (defaults)
    if (normalizedDetected !== "en") {
      setTL("en");
    } else {
      setTL("zh");
    }
    
    // Mark first message as processed
    setTimeout(() => {
      setIsFirst(false);
    }, 100);
    
  } else if (!isFirst) {
    // Subsequent messages - handle language switching
    console.log(`Detected language: ${detected} (${normalizedDetected}), current ML: ${currML} (${normalizedCurrML}), current TL: ${currTL} (${normalizedCurrTL})`);
    
    // If detected language is neither main nor target, set it as target
    if (normalizedDetected !== normalizedCurrML && normalizedDetected !== normalizedCurrTL) {
      console.log(`Detected new language: ${detected}, setting as target language`);
      setTimeout(() => {
        setTL(normalizedDetected);
      }, 100);
    } 
    // If detected language matches target language, swap main and target languages
    else if (normalizedDetected === normalizedCurrTL) {
      console.log(`Detected target language: ${detected}, swapping languages`);
      setTimeout(() => {
        const temp = normalizedCurrML;
        setML(normalizedCurrTL);
        setTL(temp);
      }, 100);
    }
    // If detected language matches main language, no change needed
    else {
      console.log(`Detected main language: ${detected}, no change needed`);
    }
  }
};
