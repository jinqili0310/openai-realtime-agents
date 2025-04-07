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
        const finalTranscript =
          !serverEvent.transcript || serverEvent.transcript === "\n"
            ? "[inaudible]"
            : serverEvent.transcript;
        if (itemId) {
          updateTranscriptMessage(itemId, finalTranscript, false);
          
          // 处理语言检测
          if (finalTranscript !== "[inaudible]" && setMainLang && setLastTargetLang) {
            detectLanguage(finalTranscript).then(detectedLang => {
              if (detectedLang !== "Unknown") {
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
        if (itemId) {
          updateTranscriptItemStatus(itemId, "DONE");
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
        
        // 验证item是否存在
        if (!itemId || !transcriptItems.some(item => item.itemId === itemId)) {
          console.warn("收到未知item的ended事件:", itemId);
          break;
        }
        
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
    const detectedLang = data.languageCode || 'Unknown';
    console.log(`GPT detected language: ${detectedLang} for text: ${text.substring(0, 20)}...`);
    return detectedLang;
  } catch (error) {
    console.error('Error detecting language with GPT:', error);
    return detectBasicLanguage(text); // 出错时回退到基本检测
  }
};

// 基本的语言检测，作为备选方案
const detectBasicLanguage = (text: string): string => {
  try {
    // 基本检测规则 - 返回标准语言名称
    if (/[a-zA-Z]/.test(text)) {
      if (/[ñáéíóúü]/.test(text)) {
        return "Spanish"; 
      } else {
        return "English";
      }
    } else if (/[\u4e00-\u9fa5]/.test(text)) {
      return "Chinese";
    } else if (/[\u3040-\u30ff]/.test(text)) {
      return "Japanese";
    } else if (/[\u0400-\u04FF]/.test(text)) {
      return "Russian";
    } else if (/[\u0600-\u06FF]/.test(text)) {
      return "Arabic";
    } else if (/[\u0900-\u097F]/.test(text)) {
      return "Hindi";
    } else if (/[\u1100-\u11FF\uAC00-\uD7AF]/.test(text)) {
      return "Korean";
    } else if (/[\u0E00-\u0E7F]/.test(text)) {
      return "Thai";
    } else if (/[\u0370-\u03FF]/.test(text)) {
      return "Greek";
    }
    
    return "Unknown";
  } catch (error) {
    console.error("Error in basic language detection:", error);
    return "Unknown";
  }
};

// Helper function to detect language (simplified version)
const detectLanguage = async (text: string): Promise<string> => {
  return detectLanguageByGPT(text);
};

// 添加延迟以确保状态更新
const updateLanguageState = (
  detected: string, 
  isFirst: boolean | undefined, 
  setML?: (lang: string) => void,
  setTL?: (lang: string) => void,
  setIsFirst?: (val: boolean) => void,
  currML?: string,
  currTL?: string
) => {
  if (!setML || !setTL) return;
  
  if (isFirst && setIsFirst) {
    // 首次消息 - 设置 ML 和 TL
    console.log(`首次语言检测: ${detected}, 设置为ML`);
    
    if (detected === "English") {
      setML("English");
      setTL("Spanish");
    } else {
      setML(detected);
      setTL("English");
    }
    
    // 延迟标记首次消息处理完成，确保状态更新
    setTimeout(() => {
      setIsFirst(false);
    }, 100);
    
  } else if (!isFirst && currML) {
    // 后续消息 - 处理语言切换
    if (detected !== currML) {
      console.log(`检测到新语言: ${detected} (不是ML: ${currML}), 更新TL`);
      
      // 通过延迟确保状态更新
      setTimeout(() => {
        setTL(detected);
      }, 100);
      
    } else {
      // 输入语言与ML相同，应该翻译到TL
      console.log(`检测到ML (${currML}), 将翻译到TL (${currTL})`);
    }
  }
};
