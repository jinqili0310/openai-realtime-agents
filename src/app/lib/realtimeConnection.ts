import { RefObject } from "react";

export async function createRealtimeConnection(
  EPHEMERAL_KEY: string,
  audioElement: RefObject<HTMLAudioElement | null>
): Promise<{ pc: RTCPeerConnection; dc: RTCDataChannel }> {
  console.log("Creating new WebRTC connection...");
  
  // 配置RTC连接，禁用不需要的部分以提高音频质量
  const pc = new RTCPeerConnection({
    iceCandidatePoolSize: 10,
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    // 优化音频优先连接
    iceTransportPolicy: "all",
    rtcpMuxPolicy: "require"
  });

  // 监听ICE连接状态
  pc.oniceconnectionstatechange = () => {
    console.log(`ICE连接状态: ${pc.iceConnectionState}`);
  };

  // 监听ICE收集状态
  pc.onicegatheringstatechange = () => {
    console.log(`ICE收集状态: ${pc.iceGatheringState}`);
  };

  // 监听SDP协商状态
  pc.onsignalingstatechange = () => {
    console.log(`信令状态: ${pc.signalingState}`);
  };

  // 监听ICE候选
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      console.log("收到ICE候选:", event.candidate.candidate.substring(0, 50) + "...");
    }
  };

  // 监控音频轨道
  pc.ontrack = (e) => {
    console.log("RTC收到轨道:", e.track.kind, e.track.id, "streams:", e.streams.length);
    
    if (e.streams && e.streams.length > 0) {
      const stream = e.streams[0];
      console.log("收到音频流:", stream.id, "轨道数量:", stream.getTracks().length);
      
      if (audioElement.current) {
        try {
          console.log("连接音频流到元素");
          
          // 先确保之前的流已断开
          if (audioElement.current.srcObject) {
            console.log("断开之前的音频流");
            audioElement.current.pause();
            audioElement.current.srcObject = null;
          }
          
          // 连接新的音频流
          audioElement.current.srcObject = stream;
          
          // 尝试播放音频
          audioElement.current.play()
            .then(() => console.log("音频元素成功开始播放"))
            .catch(err => console.error("自动播放被阻止:", err));
        } catch (err) {
          console.error("设置音频流时出错:", err);
        }
      } else {
        console.error("无法找到音频元素来连接音频流");
      }
    }
  };

  // 获取用户麦克风音频
  console.log("请求访问麦克风...");
  try {
    const ms = await navigator.mediaDevices.getUserMedia({ 
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      } 
    });
    console.log("麦克风访问成功, 添加轨道到连接");
    
    // 添加音频轨道到连接
    const audioTrack = ms.getAudioTracks()[0];
    if (audioTrack) {
      console.log("添加音频轨道:", audioTrack.label);
      pc.addTrack(audioTrack, ms);
    } else {
      console.error("没有找到音频轨道");
    }
  } catch (err) {
    console.error("获取麦克风访问失败:", err);
    throw new Error("无法访问麦克风，请检查权限");
  }

  // 创建数据通道
  console.log("创建数据通道...");
  const dc = pc.createDataChannel("oai-events", {
    ordered: true
  });
  
  // 设置数据通道事件处理
  dc.onopen = () => console.log("数据通道已打开");
  dc.onclose = () => console.log("数据通道已关闭");
  dc.onerror = (err) => console.error("数据通道错误:", err);

  // 创建和设置本地offer
  console.log("创建SDP offer...");
  const offer = await pc.createOffer({
    offerToReceiveAudio: true,
    offerToReceiveVideo: false
  });
  console.log("设置本地描述...");
  await pc.setLocalDescription(offer);

  const baseUrl = "https://api.openai.com/v1/realtime";
  const model = "gpt-4o-realtime-preview-2024-12-17";

  // 发送offer到服务器
  console.log("发送offer到OpenAI服务器...");
  try {
    const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${EPHEMERAL_KEY}`,
        "Content-Type": "application/sdp",
      },
    });
    
    if (!sdpResponse.ok) {
      const errorText = await sdpResponse.text();
      console.error("OpenAI SDP响应错误:", sdpResponse.status, errorText);
      throw new Error(`OpenAI API错误: ${sdpResponse.status} ${errorText}`);
    }

    // 设置远程描述
    const answerSdp = await sdpResponse.text();
    console.log("收到SDP回应，设置远程描述...");
    const answer: RTCSessionDescriptionInit = {
      type: "answer",
      sdp: answerSdp,
    };

    await pc.setRemoteDescription(answer);
    console.log("远程描述设置完成，WebRTC连接已建立");
  } catch (err) {
    console.error("建立WebRTC连接失败:", err);
    throw err;
  }

  return { pc, dc };
} 