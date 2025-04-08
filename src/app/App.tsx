"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { v4 as uuidv4 } from "uuid";

import Image from "next/image";

// UI components
import Transcript from "./components/Transcript";
import Events from "./components/Events";
import BottomToolbar from "./components/BottomToolbar";

// Types
import { AgentConfig, SessionStatus } from "@/app/types";

// Context providers & hooks
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";

// Utilities
import { createRealtimeConnection } from "./lib/realtimeConnection";
import {
  initAzureSpeechService,
  startAzureSpeechRecognition,
  stopAzureSpeechRecognition,
  updateTargetLanguage,
  disposeAzureSpeechService,
  registerAzureCallbacks
} from "./lib/azureSpeechService";
import { detectLanguage, updateLanguageState } from "./hooks/useHandleServerEvent";

// Agent configs
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";

// 添加语言代码到友好名称的映射
const languageCodeToName: Record<string, string> = {
  'en': 'English',
  'es': 'Spanish',
  'zh': 'Chinese',
  'ja': 'Japanese',
  'ko': 'Korean',
  'ru': 'Russian',
  'fr': 'French',
  'de': 'German',
  'ar': 'Arabic',
  'hi': 'Hindi',
  'pt': 'Portuguese',
  'it': 'Italian',
  'nl': 'Dutch',
  'el': 'Greek',
  'th': 'Thai',
  'unknown': 'Unknown'
};

// 获取友好的语言名称
const getFriendlyLanguageName = (code: string): string => {
  // Handle when a full language name is passed instead of code
  if (code.length > 2) {
    // Check if code is already a language name 
    const isFullName = Object.values(languageCodeToName).includes(code);
    if (isFullName) return code;
    
    // Handle locale formats like 'en-US'
    const baseLang = code.split('-')[0].toLowerCase();
    return languageCodeToName[baseLang] || code;
  }
  
  return languageCodeToName[code] || code;
};

// 添加window类型扩展
declare global {
  interface Window {
    lastTranscriptId: string | null;
    lastTranslationId: string | null;
  }
}

// 初始化全局变量
if (typeof window !== 'undefined') {
  window.lastTranscriptId = null;
  window.lastTranslationId = null;
}

// 添加类型定义
type ServerEvent = {
  type: string;
  itemId?: string;
  status?: string;
  item_id?: string;
  transcript?: string;
  delta?: string;
  item?: {
    id: string;
    role: string;
    content?: Array<{
      type: string;
      text: string;
    }>;
  };
  response?: {
    output?: Array<{
      type: string;
      name?: string;
      call_id?: string;
      arguments?: any;
    }>;
  };
  session?: {
    id: string;
  };
};

function App() {
  const searchParams = useSearchParams();

  const { transcriptItems, addTranscriptMessage, addTranscriptBreadcrumb, updateTranscriptItemStatus, updateTranscriptMessage, toggleTranscriptItemExpand } =
    useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] =
    useState<AgentConfig[] | null>(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("DISCONNECTED");

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] =
    useState<boolean>(true);
  const [userText, setUserText] = useState<string>("");
  const [isPTTActive, setIsPTTActive] = useState<boolean>(true);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] =
    useState<boolean>(true);
  const [mainLang, setMainLang] = useState<string>("zh");
  const [lastTargetLang, setLastTargetLang] = useState<string>("en");
  const [isFirstMessage, setIsFirstMessage] = useState<boolean>(true);

  // 添加指令更新锁定状态
  const [isInstructionUpdating, setIsInstructionUpdating] = useState<boolean>(false);

  // 添加连接重试计数和冷却期控制
  const [connectionAttempts, setConnectionAttempts] = useState<number>(0);
  const [lastConnectionAttempt, setLastConnectionAttempt] = useState<number>(0);
  const MAX_CONNECTION_ATTEMPTS = 3;
  const CONNECTION_COOLDOWN_MS = 5000; // 5秒冷却期

  // 添加Azure实时转写和翻译的状态
  const [azureInitialized, setAzureInitialized] = useState<boolean>(false);
  const [azureListening, setAzureListening] = useState<boolean>(false);
  const [realtimeTranscript, setRealtimeTranscript] = useState<string>("");
  const [realtimeTranslation, setRealtimeTranslation] = useState<string>("");
  const [realtimeFromLang, setRealtimeFromLang] = useState<string>("");
  const [realtimeToLang, setRealtimeToLang] = useState<string>("");
  
  // 添加实时消息ID引用 - 分别为转写和翻译
  const realtimeTranscriptMessageIdRef = useRef<string>("");
  const realtimeTranslationMessageIdRef = useRef<string>("");
  
  // 函数：更新或创建实时转写消息（用户侧）
  const updateRealtimeTranscriptMessage = () => {
    const existingId = realtimeTranscriptMessageIdRef.current;
    
    // 构建显示内容 - 只包含转写
    let content = "";
    
    // 添加转写内容
    if (realtimeTranscript && realtimeTranscript.trim()) {
      content = `${realtimeTranscript}`;
    } else {
      content = "正在聆听...";
    }
    
    if (existingId && transcriptItems.some(item => item.itemId === existingId)) {
      // 更新已有消息
      updateTranscriptMessage(existingId, content, false);
    } else {
      // 创建新消息
      const newId = uuidv4().slice(0, 32);
      realtimeTranscriptMessageIdRef.current = newId;
      addTranscriptMessage(newId, "user", content);
    }
  };
  
  // 函数：更新或创建实时翻译消息（agent侧）
  const updateRealtimeTranslationMessage = () => {
    const existingId = realtimeTranslationMessageIdRef.current;
    
    // 构建显示内容 - 只包含翻译
    let content = "";
    
    // 添加语言标识和翻译内容
    if (realtimeTranslation && realtimeTranslation.trim()) {
      content = `${realtimeTranslation}`;
    } else if (realtimeTranscript && realtimeTranscript.trim()) {
      content = "正在翻译...";
    } else {
      // 如果没有任何内容，不创建或更新消息
      return;
    }
    
    if (existingId && transcriptItems.some(item => item.itemId === existingId)) {
      // 更新已有消息
      updateTranscriptMessage(existingId, content, false);
    } else {
      // 创建新消息
      const newId = uuidv4().slice(0, 32);
      realtimeTranslationMessageIdRef.current = newId;
      addTranscriptMessage(newId, "assistant", content);
    }
  };

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dcRef.current && dcRef.current.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dcRef.current.send(JSON.stringify(eventObj));
    } else {
      logClientEvent(
        { attemptedEvent: eventObj.type },
        "error.data_channel_not_open"
      );
      console.error(
        "Failed to send message - no data channel available",
        eventObj
      );
    }
  };

  const handleServerEventRef = useCallback((event: ServerEvent) => {
    console.log("Received server event:", event);
    
    if (event.type === "status_update") {
      const { itemId, status } = event;
      console.log("Processing status update:", { itemId, status });
      
      if (status === "DONE") {
        console.log("Status is DONE, looking for message with itemId:", itemId);
        const message = transcriptItems.find(item => item.itemId === itemId);
        console.log("Found message:", message);
        
        if (message && message.role === "assistant") {
          console.log("Processing assistant message:", message);
          const content = event.item?.content?.[0]?.text || "";
          console.log("Message content:", content);
          
          // 显示翻译结果
          addTranscriptMessage(itemId || "", "assistant", content);
          
          // 如果启用了音频播放，朗读翻译结果
          if (isAudioPlaybackEnabled) {
            // When English is detected, we should translate to Chinese (mainLang)
            // When Chinese is detected, we should translate to English (lastTargetLang)
            // Determine which language to use for TTS based on input language
            const messageLanguage = message.role === "assistant" ? 
              (realtimeFromLang === "en" || realtimeFromLang.startsWith("en-") ? "zh" : "en") : 
              lastTargetLang;
              
            console.log(`Playing TTS with language: ${messageLanguage}, detected from: ${realtimeFromLang}`);
            playTranslationTTS(content, messageLanguage);
          }
        }
      }
    } else if (event.type === "response.output_item.done" || event.type === "conversation.item.created") {
      // Process translation events from both response.output_item.done and conversation.item.created
      const itemId = event.item?.id;
      const content = event.item?.content?.[0]?.text || "";
      const role = event.item?.role || "";
      
      // Make sure this is an assistant message
      if (itemId && content && role === "assistant") {
        console.log(`Processing ${event.type} result:`, { itemId, content });
        
        // Always display translation in transcript
        addTranscriptMessage(itemId, "assistant", content);
        
        // 如果启用了音频播放，朗读翻译结果
        if (isAudioPlaybackEnabled) {
          // When English is detected, we should translate to Chinese (mainLang)
          // When Chinese is detected, we should translate to English (lastTargetLang)
          // Determine which language to use for TTS based on input language
          const messageLanguage = role === "assistant" ? 
            (realtimeFromLang === "en" || realtimeFromLang.startsWith("en-") ? "zh" : "en") : 
            lastTargetLang;
            
          console.log(`Playing TTS with language: ${messageLanguage}, detected from: ${realtimeFromLang}`);
          playTranslationTTS(content, messageLanguage);
        }
      }
    } else if (event.type === "conversation.item.updated") {
      // Handle updated items, which may contain the latest translation
      const itemId = event.item?.id;
      const content = event.item?.content?.[0]?.text || "";
      const role = event.item?.role || "";
      
      if (itemId && content && role === "assistant") {
        console.log(`Processing updated message:`, { itemId, content });
        
        // Update the existing message or create a new one
        const existingMessage = transcriptItems.find(item => item.itemId === itemId);
        if (existingMessage) {
          updateTranscriptMessage(itemId, content, false);
        } else {
          addTranscriptMessage(itemId, "assistant", content);
        }
        
        // Play TTS for the updated content
        if (isAudioPlaybackEnabled) {
          // When English is detected, we should translate to Chinese (mainLang)
          // When Chinese is detected, we should translate to English (lastTargetLang)
          // Determine which language to use for TTS based on input language
          const messageLanguage = role === "assistant" ? 
            (realtimeFromLang === "en" || realtimeFromLang.startsWith("en-") ? "zh" : "en") : 
            lastTargetLang;
            
          console.log(`Playing TTS with language: ${messageLanguage}, detected from: ${realtimeFromLang}`);
          playTranslationTTS(content, messageLanguage);
        }
      }
    } else if (event.type === "conversation.item.input_audio_transcription.completed") {
      // Process transcription events with language detection
      const itemId = event.item_id;
      const transcript = event.transcript || "";
      
      if (itemId && transcript && transcript.trim() !== "" && transcript !== "\n") {
        console.log(`Processing transcription: "${transcript.substring(0, 30)}..."`);
        
        // Detect the language of the transcript
        if (transcript !== "[inaudible]") {
          detectLanguage(transcript).then(detectedLang => {
            if (detectedLang !== "unknown") {
              console.log(`Language detected in transcription: ${detectedLang}`);
              
              // Import the update function and use it
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
    }
  }, [transcriptItems, isAudioPlaybackEnabled, lastTargetLang, addTranscriptMessage, updateTranscriptMessage, updateTranscriptItemStatus, 
      mainLang, setMainLang, setLastTargetLang, isFirstMessage, setIsFirstMessage]);

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      const url = new URL(window.location.toString());
      url.searchParams.set("agentConfig", finalAgentConfig);
      window.location.replace(url.toString());
      return;
    }

    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";

    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      connectToRealtime();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (
      sessionStatus === "CONNECTED" &&
      selectedAgentConfigSet &&
      selectedAgentName
    ) {
      // 确保音频元素已添加到DOM并设置正确
      if (audioElementRef.current && !document.body.contains(audioElementRef.current)) {
        audioElementRef.current.id = 'translator-audio-element';
        document.body.appendChild(audioElementRef.current);
        console.log("Audio element added to DOM");
      }
      
      const currentAgent = selectedAgentConfigSet.find(
        (a) => a.name === selectedAgentName
      );
      addTranscriptBreadcrumb(
        `Agent: ${selectedAgentName}`,
        currentAgent
      );
      
      // 更新会话，但不发送初始"hi"消息
      updateSession(false);
      
      // 延迟发送欢迎消息，确保会话更新已完成
      setTimeout(() => {
        // 生成唯一ID
        const welcomeId = uuidv4().slice(0, 32);
        
        // 发送欢迎消息事件以触发语音合成
        sendClientEvent(
          {
            type: "conversation.item.create",
            item: {
              id: welcomeId,
              type: "message",
              role: "assistant",
              content: [
                { 
                  type: "text", 
                  text: "Welcome to the Translator! I can translate in both directions: Chinese ↔ English. Start speaking in either language, and I'll automatically detect and translate for you." 
                }
              ],
            },
          },
          "(send welcome message)"
        );
        
        // 在UI中显示欢迎消息
        addTranscriptMessage(
          welcomeId, 
          "assistant", 
          "Welcome to the Translator! I can translate in both directions: Chinese ↔ English. Start speaking in either language, and I'll automatically detect and translate for you."
        );
        
        // 更新消息状态为已完成
        setTimeout(() => {
          updateTranscriptItemStatus(welcomeId, "DONE");
        }, 100);
      }, 500);
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      console.log(
        `updatingSession, isPTTACtive=${isPTTActive} sessionStatus=${sessionStatus}`
      );
      updateSession();
    }
  }, [isPTTActive, mainLang, lastTargetLang]);

  const fetchEphemeralKey = async (): Promise<string | null> => {
    logClientEvent({ url: "/session" }, "fetch_session_token_request");
    const tokenResponse = await fetch("/api/session");
    const data = await tokenResponse.json();
    logServerEvent(data, "fetch_session_token_response");

    if (!data.client_secret?.value) {
      logClientEvent(data, "error.no_ephemeral_key");
      console.error("No ephemeral key provided by the server");
      setSessionStatus("DISCONNECTED");
      return null;
    }

    return data.client_secret.value;
  };

  const connectToRealtime = async () => {
    // 添加连接尝试次数和冷却期检查
    const now = Date.now();
    if (connectionAttempts >= MAX_CONNECTION_ATTEMPTS && 
        now - lastConnectionAttempt < CONNECTION_COOLDOWN_MS) {
      console.log(`已达到最大连接尝试次数(${MAX_CONNECTION_ATTEMPTS})，正在冷却中...`);
      
      // 显示连接失败消息
      addTranscriptMessage(
        uuidv4().slice(0, 32),
        "assistant", 
        "连接失败次数过多，请稍后再试或刷新页面。"
      );
      
      return;
    }
    
    if (sessionStatus !== "DISCONNECTED") return;
    
    // 更新连接尝试记录
    setConnectionAttempts(prev => prev + 1);
    setLastConnectionAttempt(now);
    
    // 设置连接状态为连接中
    setSessionStatus("CONNECTING");
    console.log(`开始连接到实时API... (尝试 ${connectionAttempts + 1}/${MAX_CONNECTION_ATTEMPTS})`);

    try {
      const EPHEMERAL_KEY = await fetchEphemeralKey();
      if (!EPHEMERAL_KEY) {
        console.error("获取临时密钥失败，无法连接");
        setSessionStatus("DISCONNECTED");
        return;
      }

      // 使用已有的音频元素，而不是创建新的
      // 重置音频元素状态
      if (audioElementRef.current) {
        console.log("重置音频元素状态");
        try {
          // 断开任何现有连接
          if (audioElementRef.current.srcObject) {
            console.log("断开现有音频流");
            audioElementRef.current.pause();
            audioElementRef.current.srcObject = null;
          }
          
          // 确保音频属性正确设置
          audioElementRef.current.volume = 1.0;
          audioElementRef.current.muted = !isAudioPlaybackEnabled;
          
          console.log("音频元素已重置准备好连接新流");
        } catch (e) {
          console.warn("重置音频元素时出错:", e);
        }
      } else {
        console.error("找不到音频元素引用，无法正确设置音频");
      }

      console.log("开始创建WebRTC连接...");
      // 创建WebRTC连接
      const { pc, dc } = await createRealtimeConnection(
        EPHEMERAL_KEY,
        audioElementRef
      );
      
      // 设置数据通道错误处理
      setupDataChannelHandlers(dc);
      
      console.log("WebRTC连接创建成功，设置事件处理...");
      
      // 添加连接状态监控
      pc.onconnectionstatechange = () => {
        console.log(`WebRTC连接状态变更: ${pc.connectionState}`);
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
          console.warn(`WebRTC连接状态异常: ${pc.connectionState}，准备重新连接`);
          setSessionStatus("DISCONNECTED");
        }
      };
      
      // 改进的ontrack事件处理
      pc.ontrack = (event) => {
        console.log("收到音频轨道:", event.track.kind, event.track.id);
        
        if (event.streams && event.streams.length > 0) {
          const stream = event.streams[0];
          console.log("获取到音频流:", stream.id, "轨道数量:", stream.getTracks().length);
          
          // 确保音频元素存在并连接
          if (audioElementRef.current) {
            try {
              // 断开任何现有连接
              if (audioElementRef.current.srcObject) {
                console.log("断开现有音频流");
                audioElementRef.current.pause();
                audioElementRef.current.srcObject = null;
              }
              
              // 连接新的音频流
              console.log("连接新的音频流");
              audioElementRef.current.srcObject = stream;
              
              // 强制播放并处理可能的错误
              const playPromise = audioElementRef.current.play();
              if (playPromise !== undefined) {
                playPromise.then(() => {
                  console.log("音频播放已开始!");
                }).catch(error => {
                  console.error("自动播放被阻止:", error);
                  
                  // 创建用户激活播放的按钮
                  const playButton = document.createElement('button');
                  playButton.textContent = '点击启用音频';
                  playButton.style.cssText = 'position:fixed; top:10px; right:10px; padding:8px 12px; background:#4CAF50; color:white; z-index:1000; border-radius:4px; font-weight:bold; box-shadow:0 2px 4px rgba(0,0,0,0.2);';
                  
                  playButton.onclick = () => {
                    if (audioElementRef.current) {
                      audioElementRef.current.play();
                      playButton.remove();
                    }
                  };
                  
                  document.body.appendChild(playButton);
                });
              }
            } catch (e) {
              console.error("设置音频源出错:", e);
            }
          } else {
            console.error("音频元素不存在，无法连接音频流");
          }
        } else {
          console.warn("收到轨道但没有关联的流");
        }
      };

      pcRef.current = pc;
      dcRef.current = dc;

      // 处理数据通道打开事件
      dc.addEventListener("open", () => {
        console.log("数据通道已打开，连接成功");
        logClientEvent({}, "data_channel.open");
        setSessionStatus("CONNECTED");
        
        // 数据通道打开后，更新会话
        setTimeout(() => {
          updateSession();
        }, 500);
      });
      
      dc.addEventListener("close", () => {
        console.log("数据通道已关闭");
        logClientEvent({}, "data_channel.close");
        setSessionStatus("DISCONNECTED");
      });
      
      dc.addEventListener("error", (err: any) => {
        console.error("数据通道错误:", err);
        logClientEvent({ error: err }, "data_channel.error");
        setSessionStatus("DISCONNECTED");
      });
      
      dc.addEventListener("message", (e: MessageEvent) => {
        handleServerEventRef(JSON.parse(e.data));
      });

      setDataChannel(dc);
    } catch (err) {
      console.error("连接到实时API时出错:", err);
      setSessionStatus("DISCONNECTED");
    }
  };

  const disconnectFromRealtime = () => {
    if (pcRef.current) {
      pcRef.current.getSenders().forEach((sender) => {
        if (sender.track) {
          sender.track.stop();
        }
      });

      pcRef.current.close();
      pcRef.current = null;
    }
    setDataChannel(null);
    setSessionStatus("DISCONNECTED");
    setIsPTTUserSpeaking(false);

    logClientEvent({}, "disconnected");
  };

  const sendSimulatedUserMessage = (text: string) => {
    const id = uuidv4().slice(0, 32);
    addTranscriptMessage(id, "user", text, true);

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          id,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      },
      "(simulated user text message)"
    );
    sendClientEvent(
      { type: "response.create" },
      "(trigger response after simulated user text message)"
    );
  };

  const updateSession = (shouldTriggerResponse: boolean = false) => {
    try {
      sendClientEvent(
        { type: "input_audio_buffer.clear" },
        "clear audio buffer on session update"
      );
  
      const currentAgent = selectedAgentConfigSet?.find(
        (a) => a.name === selectedAgentName
      );
  
      const turnDetection = null;
  
      // 替换指令中的变量并添加时间戳以避免缓存
      let instructions = currentAgent?.instructions || "";
      
      // 在指令内部添加重置指令，而不是通过单独的系统消息
      if (mainLang && lastTargetLang) {
        instructions = instructions.replace(/\${actualML}/g, mainLang);
        instructions = instructions.replace(/\${actualTL}/g, lastTargetLang);
        
        // 添加时间戳注释，强制模型重新解析指令
        const timestamp = Date.now();
        instructions += `\n\n// SYSTEM RESET: Translation settings updated at ${timestamp}`;
        instructions += `\n// IMPORTANT: From now on, translate: ML=${mainLang}, TL=${lastTargetLang}`;
      }
      
      console.log(`更新会话指令: ML=${mainLang}, TL=${lastTargetLang}, 时间戳=${Date.now()}`);
  
      const tools = currentAgent?.tools || [];
  
      const sessionUpdateEvent = {
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          instructions,
          voice: "shimmer",
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          input_audio_transcription: { model: "whisper-1" },
          turn_detection: turnDetection,
          tools,
        },
      };
  
      sendClientEvent(sessionUpdateEvent);
  
      if (shouldTriggerResponse) {
        sendSimulatedUserMessage("hi");
      }
    } catch (error) {
      console.error("更新会话时出错:", error);
    }
  };

  const cancelAssistantSpeech = async () => {
    const mostRecentAssistantMessage = [...transcriptItems]
      .reverse()
      .find((item) => item.role === "assistant" && item.status === "IN_PROGRESS");

    if (!mostRecentAssistantMessage) {
      console.log("No active assistant message to cancel");
      return;
    }
    
    // 检查item_id是否有效，确保不是截断或无效的ID
    if (!mostRecentAssistantMessage.itemId || 
        mostRecentAssistantMessage.itemId.length < 36 || 
        !mostRecentAssistantMessage.itemId.includes('-')) {
      console.warn("无效的item_id，跳过取消请求:", mostRecentAssistantMessage.itemId);
      return;
    }
    
    console.log("取消助手消息:", mostRecentAssistantMessage.itemId);
    
    try {
      // 发送取消请求
      sendClientEvent({
        type: "conversation.item.truncate",
        item_id: mostRecentAssistantMessage.itemId,
        content_index: 0,
        audio_end_ms: Date.now() - mostRecentAssistantMessage.createdAtMs,
      });
      
      sendClientEvent(
        { type: "response.cancel" },
        "(cancel due to user interruption)"
      );
      
      // 向用户显示清除指示
      addTranscriptBreadcrumb("已取消助手回应");
      
    } catch (error) {
      console.error("Error canceling assistant speech:", error);
    }
  };

  const handleSendTextMessage = () => {
    if (!userText.trim()) return;
    
    try {
      cancelAssistantSpeech();
    } catch (error) {
      console.warn("取消消息时出错，但继续发送新消息:", error);
    }

    // 清除输入缓冲区，防止冲突
    sendClientEvent(
      { type: "input_audio_buffer.clear" },
      "clear PTT buffer"
    );

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userText.trim() }],
        },
      },
      "(send user text message)"
    );
    setUserText("");

    sendClientEvent({ type: "response.create" }, "trigger response");
  };

  const handleTalkButtonDown = () => {
    // 如果指令正在更新，阻止录音
    if (isInstructionUpdating) {
      console.log("指令更新中，请稍候再试...");
      addTranscriptMessage(
        uuidv4().slice(0, 32),
        "assistant",
        "指令更新中，请稍候再试..."
      );
      return;
    }
    
    // 验证连接状态
    const isConnected = sessionStatus === "CONNECTED";
    const isDataChannelOpen = dcRef.current?.readyState === "open";
    
    if (!isConnected || !isDataChannelOpen) {
      console.log(`无法开始录音: 连接状态=${sessionStatus}, 数据通道状态=${dcRef.current?.readyState || "未创建"}`);
      
      // 如果连接已断开，尝试重新连接
      if (sessionStatus === "DISCONNECTED") {
        console.log("检测到连接已断开，尝试重新连接...");
        connectToRealtime();
        
        // 显示重连提示
        addTranscriptMessage(
          uuidv4().slice(0, 32),
          "assistant",
          "连接已断开，正在尝试重新连接，请稍后再试..."
        );
      } else if (sessionStatus === "CONNECTING") {
        // 显示连接中提示
        addTranscriptMessage(
          uuidv4().slice(0, 32),
          "assistant",
          "正在连接中，请稍候..."
        );
      }
      return;
    }
    
    console.log("开始录音...");
    
    // 检查是否有活跃的助手消息需要取消
    const hasActiveAssistantMessage = transcriptItems.some(
      item => item.role === "assistant" && item.status === "IN_PROGRESS"
    );
    
    // 如果有活跃的助手消息，先取消它
    if (hasActiveAssistantMessage) {
      console.log("取消活跃的助手消息");
      cancelAssistantSpeech();
    }

    // 设置录音状态为活跃
    setIsPTTUserSpeaking(true);
    
    // 清空录音缓冲区
    try {
      sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
    } catch (error) {
      console.error("清空音频缓冲区错误:", error);
      setIsPTTUserSpeaking(false);
      
      // 使用安全类型比较
      if (sessionStatus !== "CONNECTED" && sessionStatus !== "CONNECTING") {
        console.log("发送事件失败，尝试重新连接...");
        
        // 添加连接尝试控制
        if (connectionAttempts < MAX_CONNECTION_ATTEMPTS) {
          disconnectFromRealtime();
          setTimeout(() => connectToRealtime(), 500);
        } else {
          addTranscriptMessage(
            uuidv4().slice(0, 32),
            "assistant", 
            "连接失败次数过多，请刷新页面重试。"
          );
        }
      }
    }

    // 开始Azure语音识别和翻译
    if (azureInitialized && !azureListening) {
      console.log("开始Azure实时转写和翻译...");
      try {
        // 使用更通用的语言代码转换函数
        const getLocaleFromCode = (code: string): string => {
          const localeMap: Record<string, string> = {
            'en': 'en-US',
            'zh': 'zh-CN',
            'es': 'es-ES',
            'fr': 'fr-FR',
            'de': 'de-DE',
            'ja': 'ja-JP',
            'ru': 'ru-RU',
            'ko': 'ko-KR',
            'ar': 'ar-SA',
            'pt': 'pt-BR',
            'it': 'it-IT'
          };
          
          if (code.includes('-')) return code;
          return localeMap[code.toLowerCase()] || 'en-US';
        };
        
        const targetLangCode = getLocaleFromCode(lastTargetLang);
        console.log(`Starting Azure speech recognition with target language: ${targetLangCode} (from ${lastTargetLang})`);
        
        // 强制标记老消息为完成
        if (realtimeTranscriptMessageIdRef.current) {
          // 如果有上一轮的消息，将其标记为完成
          updateTranscriptItemStatus(realtimeTranscriptMessageIdRef.current, "DONE");
        }
        
        if (realtimeTranslationMessageIdRef.current) {
          // 如果有上一轮的消息，将其标记为完成
          updateTranscriptItemStatus(realtimeTranslationMessageIdRef.current, "DONE");
        }
        
        // 完全清空引用和状态 - 非常重要
        realtimeTranscriptMessageIdRef.current = "";
        realtimeTranslationMessageIdRef.current = "";
        
        // 清空实时转写和翻译 - 确保每次新录音完全重置状态
        setRealtimeTranscript("");
        setRealtimeTranslation("");
        setRealtimeFromLang("");
        setRealtimeToLang("");
        
        // 强制创建新的空消息 - 不依赖于转写和翻译状态
        const newTranscriptId = uuidv4().slice(0, 32);
        realtimeTranscriptMessageIdRef.current = newTranscriptId;
        addTranscriptMessage(newTranscriptId, "user", "正在聆听...");
        
        // 在确保创建了新消息后再启动Azure
        setTimeout(() => {
          startAzureSpeechRecognition(targetLangCode, true);
          setAzureListening(true);
        }, 100);
      } catch (error) {
        console.error("启动Azure语音识别失败:", error);
        setAzureListening(false);
      }
    } else if (!azureInitialized) {
      console.error("Azure语音服务未初始化，无法开始实时转写");
    }
  };

  const handleTalkButtonUp = () => {
    if (!isPTTUserSpeaking) {
      console.log("Not currently recording, ignoring button up event");
      return;
    }
    
    console.log("Stopping recording...");
    
    // 先设置状态为非录音状态
    setIsPTTUserSpeaking(false);
    
    // 如果连接已断开，不尝试发送事件
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open") {
      console.log("Cannot stop recording: not connected");
      return;
    }
    
    // 停止Azure语音识别和翻译
    if (azureInitialized && azureListening) {
      console.log("停止Azure语音识别和翻译");
      stopAzureSpeechRecognition();
      setAzureListening(false);
      
      // 获取实时消息ID
      const transcriptMessageId = realtimeTranscriptMessageIdRef.current;
      
      // 如果有转写结果，发送给OpenAI
      if (realtimeTranscript && realtimeTranscript.trim()) {
        console.log("发送最终转写结果给OpenAI:", realtimeTranscript);
        
        try {
          // 保持实时转写消息不变，不添加"处理中"状态
          if (transcriptMessageId) {
            // 将状态设为IN_PROGRESS但不改变内容
            updateTranscriptItemStatus(transcriptMessageId, "IN_PROGRESS");
          }
          
          // 使用自定义函数发送用户消息，不创建新消息而是复用实时消息
          sendCustomUserMessage(realtimeTranscript, transcriptMessageId);
          
          return;
        } catch (error) {
          console.error("使用Azure转写结果发送消息失败:", error);
        }
      } else {
        console.log("Azure未提供有效的转写结果，回退到OpenAI处理");
        
        // 如果有实时消息但没有有效的转写结果，隐藏实时消息
        if (transcriptMessageId) {
          updateTranscriptMessage(transcriptMessageId, "", false);
          updateTranscriptItemStatus(transcriptMessageId, "DONE");
          toggleTranscriptItemExpand(transcriptMessageId);
          realtimeTranscriptMessageIdRef.current = "";
        }
      }
    }
    
    try {
      // 提交录音缓冲区
      sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
      
      // 延迟一点再触发响应创建，确保缓冲区已提交
      setTimeout(() => {
        sendClientEvent({ type: "response.create" }, "trigger response PTT");
      }, 200);
    } catch (error) {
      console.error("Error in handleTalkButtonUp:", error);
    }
  };

  // 修改自定义发送用户消息函数
  const sendCustomUserMessage = (text: string, transcriptId: string) => {
    // 如果没有有效的转写消息ID，创建一个新的消息
    const messageId = transcriptId || uuidv4().slice(0, 32);
    
    // 如果我们不使用转写消息ID，添加一个新消息
    if (!transcriptId) {
      addTranscriptMessage(messageId, "user", text, true);
    }

    // 保存消息ID，以便在服务器响应中使用
    if (typeof window !== 'undefined') {
      window.lastTranscriptId = transcriptId;
    }

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          id: messageId,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      },
      "(custom user text message)"
    );
    sendClientEvent(
      { type: "response.create" },
      "(trigger response after custom user text message)"
    );
  };

  const onToggleConnection = () => {
    if (sessionStatus === "CONNECTED" || sessionStatus === "CONNECTING") {
      disconnectFromRealtime();
      setSessionStatus("DISCONNECTED");
    } else {
      connectToRealtime();
    }
  };

  const handleAgentChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newAgentConfig = e.target.value;
    const url = new URL(window.location.toString());
    url.searchParams.set("agentConfig", newAgentConfig);
    window.location.replace(url.toString());
  };

  const handleSelectedAgentChange = (
    e: React.ChangeEvent<HTMLSelectElement>
  ) => {
    const newAgentName = e.target.value;
    setSelectedAgentName(newAgentName);
  };

  useEffect(() => {
    // Don't load isPTTActive from localStorage, always set to true
    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) {
      setIsEventsPaneExpanded(storedLogsExpanded === "true");
    }
    const storedAudioPlaybackEnabled = localStorage.getItem(
      "audioPlaybackEnabled"
    );
    if (storedAudioPlaybackEnabled) {
      setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("pushToTalkUI", isPTTActive.toString());
  }, [isPTTActive]);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem(
      "audioPlaybackEnabled",
      isAudioPlaybackEnabled.toString()
    );
  }, [isAudioPlaybackEnabled]);

  // 在ML或TL更新时更新会话而不是强制断开重连
  useEffect(() => {
    if (sessionStatus === "CONNECTED" && (mainLang || lastTargetLang)) {
      console.log(`Language changed: ML=${mainLang}, TL=${lastTargetLang}`);
      
      // 设置指令更新锁定状态
      setIsInstructionUpdating(true);
      
      // 使用更安全的方式：直接更新会话而不是断开重连
      try {
        // 延迟更新会话指令，确保状态更新
        setTimeout(() => {
          // 更新会话指令而不断开连接
          updateSession();
          
          console.log("语言更新完成，会话已更新");
          
          // 简单延迟后解除锁定
          setTimeout(() => {
            setIsInstructionUpdating(false);
          }, 1000); 
        }, 500);
        
        // 如果处于录音状态，停止录音（避免状态不一致）
        if (isPTTUserSpeaking) {
          setIsPTTUserSpeaking(false);
        }
      } catch (err) {
        console.error("语言更新失败:", err);
        setIsInstructionUpdating(false);
      }
    }
  }, [mainLang, lastTargetLang]);

  // 添加连接状态监控，有限制地尝试重新连接
  useEffect(() => {
    if (sessionStatus === "DISCONNECTED" && selectedAgentName) {
      console.log("检测到连接断开，自动尝试重新连接...");
      
      // 添加连接尝试限制
      if (connectionAttempts < MAX_CONNECTION_ATTEMPTS) {
        const reconnectTimer = setTimeout(() => {
          connectToRealtime();
        }, 1000);
        
        return () => clearTimeout(reconnectTimer);
      } else {
        // 如果超过最大尝试次数，显示错误并提示刷新
        if (Date.now() - lastConnectionAttempt > CONNECTION_COOLDOWN_MS) {
          // 冷却期结束后重置尝试计数
          setConnectionAttempts(0);
        } else {
          console.log("已达到最大重连次数，请刷新页面重试");
        }
      }
    }
  }, [sessionStatus, selectedAgentName, connectionAttempts]);

  // 添加重置连接计数的机制
  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      // 连接成功后重置尝试计数
      setConnectionAttempts(0);
    }
  }, [sessionStatus]);

  // 添加音频播放状态监听
  useEffect(() => {
    if (audioElementRef.current) {
      const audioEl = audioElementRef.current;
      
      // 添加音频事件监听
      const onPlay = () => {
        console.log("音频开始播放");
        // 播放成功时显示提示
        addTranscriptMessage(
          uuidv4().slice(0, 32),
          "assistant",
          "🔊 Audio enabled, you can now hear voice output"
        );
      };
      const onPause = () => console.log("音频暂停");
      const onEnded = () => console.log("音频播放结束");
      const onError = (e: any) => {
        console.error("音频播放错误:", e);
        // 播放失败时显示提示
        addTranscriptMessage(
          uuidv4().slice(0, 32),
          "assistant",
          "⚠️ Audio playback failed, please click the 'Play Audio' button to enable sound manually"
        );
      };
      
      audioEl.addEventListener('play', onPlay);
      audioEl.addEventListener('pause', onPause);
      audioEl.addEventListener('ended', onEnded);
      audioEl.addEventListener('error', onError);
      
      return () => {
        // 清理事件监听
        audioEl.removeEventListener('play', onPlay);
        audioEl.removeEventListener('pause', onPause);
        audioEl.removeEventListener('ended', onEnded);
        audioEl.removeEventListener('error', onError);
      };
    }
  }, []);

  useEffect(() => {
    if (audioElementRef.current) {
      audioElementRef.current.muted = !isAudioPlaybackEnabled;
      
      if (isAudioPlaybackEnabled) {
        audioElementRef.current.play().catch((e) => {
          console.warn("启用音频播放失败:", e);
        });
      } else {
        audioElementRef.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  // 添加一个函数来管理音频状态
  const tryToPlayAudio = () => {
    if (!audioElementRef.current) return;
    
    try {
      console.log("尝试播放音频");
      audioElementRef.current.muted = false;
      setIsAudioPlaybackEnabled(true);
      
      const playPromise = audioElementRef.current.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => console.log("音频播放成功!"))
          .catch(err => {
            console.error("自动播放被阻止:", err);
            
            // 显示播放提示
            addTranscriptMessage(
              uuidv4().slice(0, 32),
              "assistant",
              "Please click the 'Play Audio' button on the interface to enable sound"
            );
          });
      }
    } catch (err) {
      console.error("播放音频出错:", err);
    }
  };

  // 监听音频状态变化
  useEffect(() => {
    // 当连接状态变为已连接时，尝试播放音频
    if (sessionStatus === "CONNECTED") {
      // 延迟一点，确保连接和音频流都已就绪
      setTimeout(tryToPlayAudio, 1000);
    }
  }, [sessionStatus]);

  const agentSetKey = searchParams.get("agentConfig") || "default";

  // 添加全局错误处理
  useEffect(() => {
    const handleWebRTCError = (event: any) => {
      console.error("WebRTC错误:", event);
      
      // 显示错误消息给用户
      if (event.error?.message) {
        addTranscriptBreadcrumb(`连接错误: ${event.error.message}`);
      }
    };
    
    // 监听全局错误
    window.addEventListener('error', handleWebRTCError);
    
    return () => {
      window.removeEventListener('error', handleWebRTCError);
    };
  }, []);

  // 添加数据通道处理机制
  const setupDataChannelHandlers = (dataChannel: RTCDataChannel) => {
    // 数据通道错误处理
    dataChannel.onerror = (error) => {
      console.error("数据通道错误:", error);
      addTranscriptBreadcrumb(`数据通道错误: ${JSON.stringify(error)}`);
    };
    
    // 监控数据通道消息
    const originalOnmessage = dataChannel.onmessage;
    dataChannel.onmessage = (event) => {
      try {
        // 尝试解析消息
        const data = JSON.parse(event.data);
        
        // 检查是否有错误
        if (data.type === "error") {
          console.error("收到API错误:", data);
          
          // 显示错误消息给用户
          addTranscriptBreadcrumb(`API错误: ${data.error?.message || '未知错误'}`);
          
          // 如果是item_id相关错误，记录以便调试
          if (data.error?.code === "item_truncate_invalid_item_id") {
            console.warn("无效item_id错误:", data.error.message);
          }
        }
      } catch (e) {
        // 如果不是JSON数据，使用原始处理器
      }
      
      // 调用原始的消息处理器
      if (originalOnmessage) {
        originalOnmessage.call(dataChannel, event);
      }
    };
  };

  // 修改Azure语音回调函数处理
  useEffect(() => {
    if (azureInitialized) {
      // 定义转写和翻译的回调函数
      const handleTranscription = (result: { text: string; language: string; isFinal: boolean }) => {
        console.log(`Azure 转写: ${result.text}, 是最终结果: ${result.isFinal}`);
        
        // 始终使用最新的转写结果更新状态
        setRealtimeTranscript(result.text);
        setRealtimeFromLang(result.language);
        
        // 对于空结果或者初始结果，确保使用提示文本
        if (!result.text || result.text.trim() === "") {
          // 强制更新为提示文本
          if (realtimeTranscriptMessageIdRef.current) {
            updateTranscriptMessage(realtimeTranscriptMessageIdRef.current, "正在聆听...", false);
          }
        } else if (realtimeTranscriptMessageIdRef.current) {
          // 对于有内容的结果，直接更新消息
          updateTranscriptMessage(realtimeTranscriptMessageIdRef.current, result.text, false);
        }
      };
      
      const handleTranslation = (result: { 
        originalText: string; 
        translatedText: string; 
        fromLanguage: string; 
        toLanguage: string; 
        isFinal: boolean 
      }) => {
        // Update the translation state
        console.log(`Azure 翻译: ${result.translatedText}, 从 ${result.fromLanguage} 到 ${result.toLanguage}`);
        setRealtimeTranslation(result.translatedText);
        setRealtimeToLang(result.toLanguage);
        
        // Display the translation in the UI if it's a final result
        if (result.isFinal && result.translatedText.trim()) {
          // Create a new ID for the translation message if we don't have one
          if (!realtimeTranslationMessageIdRef.current) {
            realtimeTranslationMessageIdRef.current = uuidv4().slice(0, 32);
          }
          
          // Add the translation to the transcript
          addTranscriptMessage(
            realtimeTranslationMessageIdRef.current,
            "assistant",
            result.translatedText
          );
          
          // Play TTS for the translation but don't create a duplicate message
          if (isAudioPlaybackEnabled) {
            // When English is detected, we should use Chinese voice for TTS
            // When Chinese is detected, we should use English voice for TTS
            const detectedLang = result.fromLanguage.split('-')[0].toLowerCase();
            const ttsLanguage = detectedLang === 'en' ? 'zh' : 'en';
            
            console.log(`Playing TTS with language: ${ttsLanguage} based on detected: ${detectedLang}`);
            playTranslationTTS(result.translatedText, ttsLanguage);
          }
          
          // Silently detect and update language settings without notifications
          if (result.fromLanguage) {
            const detectedLang = result.fromLanguage.split('-')[0].toLowerCase();
            
            // Only update languages if they're different from current
            if (detectedLang === 'zh' && mainLang !== 'zh') {
              console.log(`Detected Chinese input, silently updating languages: ML=zh, TL=en`);
              setMainLang('zh');
              setLastTargetLang('en');
              
              // Update Azure service silently
              const getLocaleFromCode = (code: string): string => {
                const localeMap: Record<string, string> = {
                  'en': 'en-US', 'zh': 'zh-CN', 'es': 'es-ES',
                  'fr': 'fr-FR', 'de': 'de-DE', 'ja': 'ja-JP',
                  'ru': 'ru-RU', 'ko': 'ko-KR', 'ar': 'ar-SA',
                  'pt': 'pt-BR', 'it': 'it-IT'
                };
                if (code.includes('-')) return code;
                return localeMap[code.toLowerCase()] || 'en-US';
              };
              
              updateTargetLanguage(getLocaleFromCode('en'));
            } else if (detectedLang === 'en' && mainLang !== 'en') {
              console.log(`Detected English input, silently updating languages: ML=en, TL=zh`);
              setMainLang('en');
              setLastTargetLang('zh');
              
              // Update Azure service silently
              const getLocaleFromCode = (code: string): string => {
                const localeMap: Record<string, string> = {
                  'en': 'en-US', 'zh': 'zh-CN', 'es': 'es-ES',
                  'fr': 'fr-FR', 'de': 'de-DE', 'ja': 'ja-JP',
                  'ru': 'ru-RU', 'ko': 'ko-KR', 'ar': 'ar-SA',
                  'pt': 'pt-BR', 'it': 'it-IT'
                };
                if (code.includes('-')) return code;
                return localeMap[code.toLowerCase()] || 'en-US';
              };
              
              updateTargetLanguage(getLocaleFromCode('zh'));
            }
          }
        }
      };
      
      // 注册回调函数到Azure服务
      registerAzureCallbacks(handleTranscription, handleTranslation);
    }
  }, [azureInitialized, isAudioPlaybackEnabled]);

  // 初始化Azure语音服务
  useEffect(() => {
    const initAzure = async () => {
      console.log("正在初始化Azure语音服务...");
      try {
        const success = await initAzureSpeechService(
          // 转写回调
          (result) => {
            console.log("收到Azure转写结果:", result);
            // 更新实时转写
            setRealtimeTranscript(result.text);
            if (result.language && result.language !== 'unknown') {
              setRealtimeFromLang(result.language);
            }
            
            // 如果是最终结果，发送到OpenAI进行处理
            if (result.isFinal && result.text.trim()) {
              console.log("收到最终转写结果，准备发送到OpenAI:", result.text);
              // 最终结果在松开按钮时由handleTalkButtonUp处理
              // 这里只保存结果
            }
          },
          // 翻译回调
          (result) => {
            console.log("收到Azure翻译结果:", result);
            // 更新实时翻译
            setRealtimeTranslation(result.translatedText);
            if (result.fromLanguage && result.fromLanguage !== 'unknown') {
              setRealtimeFromLang(result.fromLanguage);
            }
            if (result.toLanguage) {
              setRealtimeToLang(result.toLanguage);
            }
          }
        );
        
        console.log("Azure语音服务初始化结果:", success);
        setAzureInitialized(success);
        
        if (!success) {
          console.warn("Azure语音服务初始化失败，应用将使用OpenAI进行转写和翻译");
          // 添加一个通知消息告知用户
          setTimeout(() => {
            addTranscriptMessage(
              uuidv4().slice(0, 32),
              "assistant",
              "注意：实时转写功能不可用，将仅使用OpenAI进行语音识别和翻译。"
            );
          }, 2000);
        }
      } catch (error) {
        console.error("初始化Azure语音服务时出现错误:", error);
        setAzureInitialized(false);
        
        // 添加一个通知消息告知用户
        setTimeout(() => {
          addTranscriptMessage(
            uuidv4().slice(0, 32),
            "assistant",
            "错误：无法初始化实时转写功能，将仅使用OpenAI进行语音识别和翻译。"
          );
        }, 2000);
      }
    };
    
    // 初始化语音服务
    initAzure();
    
    // 组件卸载时清理资源
    return () => {
      disposeAzureSpeechService();
    };
  }, []);

  // 当主语言或目标语言更新时，更新Azure翻译目标语言
  useEffect(() => {
    if (azureInitialized && lastTargetLang) {
      // 将语言代码转换为Azure格式
      const getLocaleFromCode = (code: string): string => {
        const localeMap: Record<string, string> = {
          'en': 'en-US',
          'zh': 'zh-CN',
          'es': 'es-ES',
          'fr': 'fr-FR',
          'de': 'de-DE',
          'ja': 'ja-JP',
          'ru': 'ru-RU',
          'ko': 'ko-KR',
          'ar': 'ar-SA',
          'pt': 'pt-BR',
          'it': 'it-IT'
        };
        
        // If it's already a locale format (xx-XX), use it as is
        if (code.includes('-')) return code;
        
        // Otherwise, look up the mapping or use en-US as fallback
        return localeMap[code.toLowerCase()] || 'en-US';
      };
      
      const targetLangCode = getLocaleFromCode(lastTargetLang);
      console.log(`Updating Azure target language to: ${targetLangCode} (from ${lastTargetLang})`);
      
      updateTargetLanguage(targetLangCode);
    }
  }, [azureInitialized, lastTargetLang]);

  // Function to play TTS using Azure's voice synthesis with shimmer turbo voice
  const playTranslationTTS = async (text: string, language: string) => {
    if (!text || !isAudioPlaybackEnabled) return;
    
    try {
      // Don't use TTS for system messages
      if (text.startsWith('🔊') || text.startsWith('⚠️') || text.startsWith('Please click')) {
        return;
      }
      
      // Convert simple language code to locale format required by TTS
      const getLocaleFromCode = (code: string): string => {
        // Normalize the language code to lowercase
        const normalizedCode = code.toLowerCase();
        
        const localeMap: Record<string, string> = {
          'en': 'en-US',
          'zh': 'zh-CN',
          'es': 'es-ES',
          'fr': 'fr-FR',
          'de': 'de-DE',
          'ja': 'ja-JP',
          'ru': 'ru-RU',
          'ko': 'ko-KR',
          'ar': 'ar-SA',
          'pt': 'pt-BR',
          'it': 'it-IT'
        };
        
        // Handle empty or undefined code
        if (!normalizedCode) {
          console.warn('Empty language code provided, using en-US as fallback');
          return 'en-US';
        }
        
        // If it's already a locale format (xx-XX), use it as is
        if (normalizedCode.includes('-')) return normalizedCode;
        
        // Otherwise, look up the mapping or use en-US as fallback
        const locale = localeMap[normalizedCode] || 'en-US';
        console.log(`Converted language code ${normalizedCode} to locale ${locale}`);
        return locale;
      };
      
      const ttsLocale = getLocaleFromCode(language);
      console.log(`Using Azure TTS with Shimmer voice for: "${text.substring(0, 30)}..." in ${ttsLocale}`);
      
      // Use Azure TTS API as primary option
      try {
        // Call our TTS API endpoint
        console.log(`Sending TTS request with language: ${ttsLocale}`);
        const response = await fetch('/api/tts', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: text,
            language: ttsLocale // Use the properly formatted locale
          }),
        });
        
        if (!response.ok) {
          const errorData = await response.json();
          console.error("Azure TTS API error:", errorData);
          throw new Error(errorData.error || `TTS API error: ${response.statusText}`);
        }
        
        // Get the audio data and play it
        const audioData = await response.arrayBuffer();
        if (!audioData || audioData.byteLength === 0) {
          console.error("Received empty audio data from TTS API");
          throw new Error("Empty audio data received");
        }
        
        console.log(`Received audio data: ${audioData.byteLength} bytes`);
        const blob = new Blob([audioData], { type: 'audio/mp3' });
        const url = URL.createObjectURL(blob);
        
        // Create and play audio
        const audio = new Audio(url);
        audio.onerror = (e) => {
          console.error("Audio playback error:", e);
          URL.revokeObjectURL(url);
        };
        audio.onended = () => URL.revokeObjectURL(url);
        
        const playPromise = audio.play();
        if (playPromise !== undefined) {
          playPromise.catch(error => {
            console.error("Error playing audio:", error);
            URL.revokeObjectURL(url);
          });
        }
        
        console.log("Playing Azure TTS audio with Shimmer voice for", ttsLocale);
        return; // Success, no need for fallbacks
      } catch (azureTtsError) {
        console.error("Azure TTS failed:", azureTtsError);
        // Final fallback to Web Speech API if all else fails
        if ('speechSynthesis' in window) {
          console.log("Using Web Speech API as last resort fallback");
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.lang = language; // Use original language code for Web Speech API
          window.speechSynthesis.speak(utterance);
        }
      }
    } catch (error) {
      console.error("Error playing TTS for translation:", error);
      
      // Final fallback to Web Speech API if all else fails
      if ('speechSynthesis' in window) {
        try {
          console.log("Using Web Speech API as last resort fallback");
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.lang = language; // Use original language code for Web Speech API
          window.speechSynthesis.speak(utterance);
        } catch (webSpeechError) {
          console.error("Web Speech API failed:", webSpeechError);
        }
      }
    }
  };

  return (
    <div className="text-base flex flex-col h-screen bg-gray-100 text-gray-800 relative">
      <div className="p-5 text-lg font-semibold flex justify-between items-center">
        <div className="flex items-center">
          <div onClick={() => window.location.reload()} style={{ cursor: 'pointer' }}>
            <Image
              src="/openai-logomark.svg"
              alt="OpenAI Logo"
              width={20}
              height={20}
              className="mr-2"
            />
          </div>
          <div>
            Realtime API <span className="text-gray-500">Agents</span>
          </div>
        </div>
        <div className="flex items-center">
          <div className="bg-gray-200 p-2 rounded-md mr-2">
            <span className="mr-2 font-medium">ML:</span>
            <span>{getFriendlyLanguageName(mainLang)}</span>
          </div>
          <div className="bg-gray-200 p-2 rounded-md">
            <span className="mr-2 font-medium">TL:</span>
            <span>{getFriendlyLanguageName(lastTargetLang)}</span>
          </div>
          <button 
            onClick={() => {
              if (audioElementRef.current) {
                try {
                  console.log("手动触发音频播放");
                  audioElementRef.current.muted = false;
                  setIsAudioPlaybackEnabled(true);
                  const playPromise = audioElementRef.current.play();
                  if (playPromise !== undefined) {
                    playPromise
                      .then(() => console.log("音频播放已开始!"))
                      .catch(e => console.error("播放出错:", e));
                  }
                } catch (e) {
                  console.error("手动播放音频失败:", e);
                }
              }
            }}
            className="ml-2 bg-white hover:bg-gray-100 text-gray-800 font-semibold py-1 px-2 border border-gray-400 rounded shadow text-xs"
            title="Manually trigger audio playback"
          >
            Play Audio
          </button>
        </div>
        <div className="flex items-center" style={{ display: 'none' }}>
          <label className="flex items-center text-base gap-1 mr-2 font-medium">
            Scenario
          </label>
          <div className="relative inline-block">
            <select
              value={agentSetKey}
              onChange={handleAgentChange}
              className="appearance-none border border-gray-300 rounded-lg text-base px-2 py-1 pr-8 cursor-pointer font-normal focus:outline-none"
              aria-label="选择场景"
            >
              {Object.keys(allAgentSets).map((agentKey) => (
                <option key={agentKey} value={agentKey}>
                  {agentKey}
                </option>
              ))}
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-gray-600">
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M5.23 7.21a.75.75 0 011.06.02L10 10.44l3.71-3.21a.75.75 0 111.04 1.08l-4.25 3.65a.75.75 0 01-1.04 0L5.21 8.27a.75.75 0 01.02-1.06z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
          </div>

          {agentSetKey && (
            <div className="flex items-center ml-6">
              <label className="flex items-center text-base gap-1 mr-2 font-medium">
                Agent
              </label>
              <div className="relative inline-block">
                <select
                  value={selectedAgentName}
                  onChange={handleSelectedAgentChange}
                  className="appearance-none border border-gray-300 rounded-lg text-base px-2 py-1 pr-8 cursor-pointer font-normal focus:outline-none"
                  aria-label="选择代理"
                >
                  {selectedAgentConfigSet?.map(agent => (
                    <option key={agent.name} value={agent.name}>
                      {agent.name}
                    </option>
                  ))}
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-gray-600">
                  <svg
                    className="h-4 w-4"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M5.23 7.21a.75.75 0 011.06.02L10 10.44l3.71-3.21a.75.75 0 111.04 1.08l-4.25 3.65a.75.75 0 01-1.04 0L5.21 8.27a.75.75 0 01.02-1.06z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          canSend={
            sessionStatus === "CONNECTED" &&
            dcRef.current?.readyState === "open"
          }
        />

        <Events isExpanded={isEventsPaneExpanded} />
      </div>

      <BottomToolbar
        sessionStatus={sessionStatus}
        onToggleConnection={onToggleConnection}
        isPTTActive={isPTTActive}
        setIsPTTActive={setIsPTTActive}
        isPTTUserSpeaking={isPTTUserSpeaking}
        handleTalkButtonDown={handleTalkButtonDown}
        handleTalkButtonUp={handleTalkButtonUp}
        isEventsPaneExpanded={isEventsPaneExpanded}
        setIsEventsPaneExpanded={setIsEventsPaneExpanded}
        isAudioPlaybackEnabled={isAudioPlaybackEnabled}
        setIsAudioPlaybackEnabled={setIsAudioPlaybackEnabled}
      />
      
      {/* 直接在DOM中放置音频元素，确保它始终存在 */}
      <audio 
        ref={audioElementRef}
        id="translator-audio-element"
        autoPlay
        playsInline
        style={{ display: "none" }}
      />
      
      {/* 添加音频播放状态指示器和播放按钮 */}
      {sessionStatus === "CONNECTED" && (
        <div className="fixed top-3 left-1/2 transform -translate-x-1/2 bg-white rounded-full shadow-md px-3 py-1 z-10 flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full ${isAudioPlaybackEnabled ? "bg-green-500" : "bg-red-500"}`}></div>
          <span className="text-sm font-medium">Audio {isAudioPlaybackEnabled ? "Enabled" : "Disabled"}</span>
          {!isAudioPlaybackEnabled && (
            <button 
              className="text-xs bg-blue-500 text-white px-2 py-0.5 rounded hover:bg-blue-600"
              onClick={() => {
                setIsAudioPlaybackEnabled(true);
                if (audioElementRef.current) {
                  audioElementRef.current.muted = false;
                  audioElementRef.current.play().catch(e => console.warn("无法自动播放:", e));
                }
              }}
            >
              启用
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
