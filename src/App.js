import React, { useEffect, useRef, useState, useCallback } from "react";
import { Pose } from "@mediapipe/pose";
import { Camera } from "@mediapipe/camera_utils";
import { drawConnectors, drawLandmarks, POSE_CONNECTIONS } from "@mediapipe/drawing_utils";
import validationRules from "./validationRules.json";
import "./App.css";

export default function LivePoseInstructor() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [metrics, setMetrics] = useState({ hip_angle: 0, knee_angle: 0, ankle_height: 0 });
  const [feedback, setFeedback] = useState("");
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [isBodyVisible, setIsBodyVisible] = useState(false);
  const [readyToStart, setReadyToStart] = useState(false);
  const [referenceVideoUrl, setReferenceVideoUrl] = useState(null);
  const [videoError, setVideoError] = useState(false);
  const referenceVideoRef = useRef(null);
  const videoStepTimesRef = useRef([]);
  const [instructionMessage, setInstructionMessage] = useState("Please stand back so your entire body is visible.");
  const [instructionType, setInstructionType] = useState("positioning"); // positioning, confirming, ready, feedback

  // Refs for stability and timing
  const landmarkBufferRef = useRef([]);
  const stableCounterRef = useRef(0);
  const currentStepIndexRef = useRef(0);
  const lastFeedbackTimeRef = useRef(0);
  const lastSpokenStepRef = useRef(null);
  const initializedRef = useRef(false);
  const poseInitializedRef = useRef(false);
  const [exerciseStartTime] = useState(Date.now());
  const lastVisibilityWarningRef = useRef(0);
  const visibilityCheckFramesRef = useRef(0);

  const SMOOTHING_FRAMES = 5;
  const REQUIRED_STABLE_FRAMES = 10;
  const FEEDBACK_COOLDOWN = 3000; // 3 seconds
  const VISIBILITY_WARNING_INTERVAL = 10000; // 10 seconds

  // Sync step ref
  useEffect(() => {
    currentStepIndexRef.current = currentStepIndex;
  }, [currentStepIndex]);

  // Voice function
  const speak = useCallback((text) => {
    if (voiceEnabled && 'speechSynthesis' in window) {
      speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.0;

      const loadVoices = () => {
        const voices = speechSynthesis.getVoices();
        const female = voices.find(v => 
          v.name.toLowerCase().includes("female") ||
          v.name.toLowerCase().includes("zira") ||
          v.name.toLowerCase().includes("samantha")
        );
        if (female) utterance.voice = female;
        speechSynthesis.speak(utterance);
      };

      if (speechSynthesis.getVoices().length === 0)
        speechSynthesis.addEventListener("voiceschanged", loadVoices);
      else loadVoices();
    }
  }, [voiceEnabled]);

  // Auto-load video from public/videos folder on component mount
  useEffect(() => {
    const loadVideoFromFolder = async () => {
      // Try to load video from public/videos folder
      const videoNames = ['a4.mov', 'exercise.mp4', 'demo.mp4', 'video.mp4'];
      
      for (const videoName of videoNames) {
        try { 
          const videoPath = `/videos/${videoName}`;
          const response = await fetch(videoPath, { method: 'HEAD' });
          if (response.ok) {
            setReferenceVideoUrl(videoPath);
            calculateStepTimeBoundaries();
            console.log(`✅ Auto-loaded video: ${videoName}`);
            return;
          }
        } catch (err) {
          continue;
        }
      }
      console.log('ℹ️ No video found in public/videos/ folder');
    };
    
    loadVideoFromFolder();
  }, []);

  // Welcome message
  useEffect(() => {
    if (!initializedRef.current && voiceEnabled) {
      initializedRef.current = true;
      setTimeout(() => {
        speak("Please stand back so your entire body is visible in the camera.");
      }, 800);
    }
  }, [speak, voiceEnabled]);

  // Check if all key body points are visible
  const checkBodyVisibility = useCallback((landmarks) => {
    const requiredPoints = [11, 12, 23, 24, 25, 26, 27, 28]; // Shoulders, hips, knees, ankles
    const visibilityThreshold = 0.5;
    
    for (let idx of requiredPoints) {
      if (!landmarks[idx] || landmarks[idx].visibility < visibilityThreshold) {
        return false;
      }
    }
    return true;
  }, []);

  // Angle calculation
  const calculateAngle = useCallback((a, b, c) => {
    const radians = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
    let angle = Math.abs((radians * 180.0) / Math.PI);
    if (angle > 180.0) angle = 360 - angle;
    return angle;
  }, []);

  // Step evaluation
  const evaluateStep = useCallback((landmarks, stepRule) => {
    const L_SHOULDER = 11, L_HIP = 23, L_KNEE = 25, L_ANKLE = 27;
    const shoulder = landmarks[L_SHOULDER];
    const hip = landmarks[L_HIP];
    const knee = landmarks[L_KNEE];
    const ankle = landmarks[L_ANKLE];

    const hip_angle = calculateAngle(shoulder, hip, knee);
    const knee_angle = calculateAngle(hip, knee, ankle);
    const ankle_height = ankle.y; // Direct y-coordinate (lower is higher on screen)

    const criteria = stepRule.criteria;
    let score = 0;

    // Hip angle - check if within range
    if (criteria.hip_angle && criteria.hip_angle.min && criteria.hip_angle.max) {
      if (hip_angle >= criteria.hip_angle.min && hip_angle <= criteria.hip_angle.max) {
        score += 2;
      }
    }

    // Ankle height - check if within acceptable range
    if (criteria.ankle_height && criteria.ankle_height.min) {
      const heightDiff = Math.abs(ankle_height - criteria.ankle_height.expected);
      if (heightDiff < 0.1) { // Within 10% tolerance
        score += 2;
      } else if (ankle_height >= criteria.ankle_height.min) {
        score += 1; // Partial credit if above minimum
      }
    }

    // Knee angle - check if close to expected
    if (criteria.knee_angle && criteria.knee_angle.expected) {
      const kneeDiff = Math.abs(knee_angle - criteria.knee_angle.expected);
      if (kneeDiff < 15) { // Within 15 degrees tolerance
        score += 1;
      }
    }

    return { score, metrics: { hip_angle, knee_angle, ankle_height } };
  }, [calculateAngle]);

  // Feedback logic
  const getFeedbackMessage = useCallback((metrics, stepRule) => {
    const c = stepRule.criteria;
    
    // Check hip angle
    if (c.hip_angle) {
      if (c.hip_angle.min && metrics.hip_angle < c.hip_angle.min) {
        return "Bend your hip more!";
      }
      if (c.hip_angle.max && metrics.hip_angle > c.hip_angle.max) {
        return "Straighten your hip!";
      }
    }
    
    // Check ankle height
    if (c.ankle_height && c.ankle_height.min) {
      if (metrics.ankle_height > c.ankle_height.expected + 0.15) {
        return "Raise your leg higher!";
      }
      if (metrics.ankle_height < c.ankle_height.min) {
        return "Lower your leg slightly!";
      }
    }
    
    // Check knee angle
    if (c.knee_angle && c.knee_angle.expected) {
      const kneeDiff = Math.abs(metrics.knee_angle - c.knee_angle.expected);
      if (kneeDiff > 20) {
        if (metrics.knee_angle > c.knee_angle.expected) {
          return "Bend your knee more!";
        } else {
          return "Straighten your knee slightly!";
        }
      }
    }
    
    return "";
  }, []);

  // Pose initialization
  useEffect(() => {
    if (!videoRef.current || !canvasRef.current || poseInitializedRef.current) return;
    poseInitializedRef.current = true;

    let pose = null;
    let camera = null;
    let isCleaningUp = false;

    const initializePose = async () => {
      pose = new Pose({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
    });
    pose.setOptions({
        modelComplexity: 1,
      smoothLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
    });
    
    pose.onResults((results) => {
        if (!canvasRef.current || isCleaningUp) return;
        
        const ctx = canvasRef.current.getContext("2d");
        ctx.save();
        ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);

        if (results.poseLandmarks) {
          const rawLandmarks = results.poseLandmarks;
          const bodyVisible = checkBodyVisibility(rawLandmarks);
          
          // Update visibility state
          if (bodyVisible) {
            visibilityCheckFramesRef.current++;
            const progress = Math.min(visibilityCheckFramesRef.current / 30, 1);
            setInstructionMessage(`Hold still... ${Math.round(progress * 100)}% confirmed`);
            setInstructionType("confirming");
            
            if (visibilityCheckFramesRef.current > 30 && !readyToStart) {
              setReadyToStart(true);
              setIsBodyVisible(true);
              setInstructionType("ready");
              setInstructionMessage(`Starting: ${validationRules.steps[0].step_name}`);
              speak(`Good! Let's start. Step 1: ${validationRules.steps[0].step_name}`);
            }
          } else {
            visibilityCheckFramesRef.current = 0;
            setInstructionMessage("⚠ Step Back - Full body needs to be visible");
            setInstructionType("positioning");
            
            if (readyToStart) {
              setReadyToStart(false);
              setIsBodyVisible(false);
            }
            // Voice warning every 10 seconds
            const now = Date.now();
            if (now - lastVisibilityWarningRef.current > VISIBILITY_WARNING_INTERVAL) {
              speak("Please step back. Your full body needs to be visible.");
              lastVisibilityWarningRef.current = now;
            }
          }

          // Draw skeleton - mirrored to match video, thicker and more visible
          ctx.save();
          ctx.translate(canvasRef.current.width, 0);
          ctx.scale(-1, 1);
          
          const skeletonColor = bodyVisible ? "#4CAF50" : "#FF9800";
          drawConnectors(ctx, rawLandmarks, POSE_CONNECTIONS, { color: skeletonColor, lineWidth: 5 });
          // Removed landmark points for cleaner view
          
          ctx.restore();

          const landmarks = rawLandmarks.map(lm => ({ x: lm.x, y: lm.y, z: lm.z }));

          // Only process exercise if body is visible and ready
          if (!readyToStart) {
            ctx.restore();
            return;
          }

          // Smooth
          landmarkBufferRef.current.push(landmarks);
          if (landmarkBufferRef.current.length > SMOOTHING_FRAMES)
            landmarkBufferRef.current.shift();

          if (landmarkBufferRef.current.length >= SMOOTHING_FRAMES) {
          const smoothed = landmarkBufferRef.current[0].map((_, i) => {
            const sum = landmarkBufferRef.current.reduce((acc, lm) => ({
              x: acc.x + lm[i].x, y: acc.y + lm[i].y, z: acc.z + lm[i].z
            }), { x: 0, y: 0, z: 0 });
            return { x: sum.x / SMOOTHING_FRAMES, y: sum.y / SMOOTHING_FRAMES, z: sum.z / SMOOTHING_FRAMES };
          });

          const stepIndex = currentStepIndexRef.current;
          const step = validationRules.steps[stepIndex];
          const { score, metrics: newMetrics } = evaluateStep(smoothed, step);
          setMetrics(newMetrics);

          // Skip feedback for first 5s
          if (Date.now() - exerciseStartTime < 5000) {
            setInstructionType("ready");
            setInstructionMessage("Exercise in progress...");
            ctx.restore();
            return;
          }

          // Stable pose → advance
          if (score >= 4) {
            stableCounterRef.current++;
            setInstructionType("ready");
            setInstructionMessage("✓ Great form! Keep holding...");
            
            if (stableCounterRef.current >= REQUIRED_STABLE_FRAMES && stepIndex < validationRules.steps.length - 1) {
              stableCounterRef.current = 0;
              currentStepIndexRef.current++;
              setCurrentStepIndex(prev => prev + 1);
              const nextStep = validationRules.steps[stepIndex + 1];
              setInstructionMessage(`Next: ${nextStep.step_name}`);
              speak(`Good job! Now ${nextStep.step_name}`);
              lastSpokenStepRef.current = nextStep.step_name;
            }
          } else stableCounterRef.current = 0;

           const fb = getFeedbackMessage(newMetrics, step);
           setFeedback(fb);
           if (fb) {
             setInstructionType("feedback");
             setInstructionMessage(fb);
             
            const now = Date.now();
            if (now - lastFeedbackTimeRef.current > FEEDBACK_COOLDOWN) {
              speak(fb);
              lastFeedbackTimeRef.current = now;
            }
          }
        }
        }
        ctx.restore();
      });

      // Initialize camera
      if (videoRef.current) {
        try {
          camera = new Camera(videoRef.current, {
        onFrame: async () => {
              if (!isCleaningUp && pose) {
          await pose.send({ image: videoRef.current });
              }
        },
        width: 640,
        height: 480,
      });
      camera.start();
        } catch (err) {
          console.error("Camera error:", err);
        }
      }
    };

    initializePose();

    return () => {
      isCleaningUp = true;
      poseInitializedRef.current = false;
      
      if (camera) {
        camera.stop();
        camera = null;
      }
      
      if (pose) {
        pose.close();
        pose = null;
      }
    };
  }, [evaluateStep, getFeedbackMessage, speak, checkBodyVisibility, readyToStart]);


  const handleRestart = () => {
    stableCounterRef.current = 0;
    currentStepIndexRef.current = 0;
    visibilityCheckFramesRef.current = 0;
    setCurrentStepIndex(0);
    setFeedback("");
    setReadyToStart(false);
    setIsBodyVisible(false);
    landmarkBufferRef.current = [];
    
    // Reset reference video to start
    if (referenceVideoRef.current) {
      referenceVideoRef.current.currentTime = 0;
      referenceVideoRef.current.pause();
    }
    
    speak("Restarting. Please ensure your full body is visible.");
  };

  const handleToggleVoice = () => setVoiceEnabled(v => !v);

  const handleVideoUpload = (event) => {
    const file = event.target.files[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setReferenceVideoUrl(url);
      
      // Calculate step time boundaries
      calculateStepTimeBoundaries();
    }
  };

  // Calculate time boundaries for each step based on start_time and end_time
  const calculateStepTimeBoundaries = () => {
    const times = [];
    
    validationRules.steps.forEach(step => {
      times.push({
        start: step.start_time,
        end: step.end_time,
        stepNumber: step.step_number
      });
    });
    
    videoStepTimesRef.current = times;
  };

  const handleRemoveVideo = () => {
    if (referenceVideoUrl) {
      URL.revokeObjectURL(referenceVideoUrl);
      setReferenceVideoUrl(null);
      videoStepTimesRef.current = [];
    }
  };

  // Handle video time update - pause at step boundaries
  const handleVideoTimeUpdate = () => {
    if (!referenceVideoRef.current || videoStepTimesRef.current.length === 0) return;
    
    const currentTime = referenceVideoRef.current.currentTime;
    const currentStepNum = currentStepIndexRef.current + 1; // step_number is 1-based
    
    // Find the time boundary for current step
    const stepBoundary = videoStepTimesRef.current.find(
      boundary => boundary.stepNumber === currentStepNum
    );
    
    if (!stepBoundary) return;
    
    // If video reaches end of current step, pause it
    if (currentTime >= stepBoundary.end - 0.5) { // 0.5 second buffer
      referenceVideoRef.current.pause();
      // Keep video at the end of current step
      referenceVideoRef.current.currentTime = stepBoundary.end;
    }
  };

  // Start reference video when user is ready
  React.useEffect(() => {
    if (readyToStart && referenceVideoRef.current && referenceVideoUrl) {
      referenceVideoRef.current.currentTime = 0;
      referenceVideoRef.current.play().catch(err => {
        console.log("Video autoplay prevented:", err);
      });
    }
  }, [readyToStart, referenceVideoUrl]);

  // Resume video when user advances to next step
  React.useEffect(() => {
    if (referenceVideoRef.current && referenceVideoUrl && currentStepIndex > 0 && videoStepTimesRef.current.length > 0) {
      // User advanced to next step, jump to start time of new step and resume video
      const currentStepBoundary = videoStepTimesRef.current.find(
        boundary => boundary.stepNumber === currentStepIndex + 1
      );
      
      if (currentStepBoundary && referenceVideoRef.current.paused) {
        referenceVideoRef.current.currentTime = currentStepBoundary.start;
        referenceVideoRef.current.play().catch(err => {
          console.log("Video play error:", err);
        });
      }
    }
  }, [currentStepIndex, referenceVideoUrl]);

  return (
    <div className="app-container">
      <div className="app-header">
        <h1>AI Exercise Instructor</h1>
        <p>Real-time pose detection and guidance</p>
      </div>

      <div className="video-section">
        <div className="video-and-instructions">
          {/* Reference Video */}
          {referenceVideoUrl ? (
            <div className="reference-video-container">
              <div className="video-header">
                <h3>📹 Reference Video</h3>
                <button onClick={handleRemoveVideo} className="remove-video-btn" title="Remove video">
                  ✕
                </button>
              </div>
              <video 
                ref={referenceVideoRef}
                className="reference-video" 
                width="640" 
                height="480"
                controls
                onTimeUpdate={handleVideoTimeUpdate}
              >
                <source src={referenceVideoUrl} type="video/mp4" />
                Your browser does not support the video tag.
              </video>
              <div className="video-sync-indicator">
                {referenceVideoRef.current?.paused && readyToStart && (
                  <div className="sync-message">
                    ⏸ Video paused - Complete current step to continue
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="video-upload-container">
              <div className="upload-placeholder">
                <div className="upload-icon">📹</div>
                <h3>No Reference Video</h3>
                <p>Place video in <code>public/videos/</code> folder</p>
                <p className="video-names">Supported names: reference.mp4, exercise.mp4, demo.mp4, video.mp4</p>
                <div className="upload-divider">OR</div>
                <label className="upload-label">
                  <input 
                    type="file" 
                    accept="video/*" 
                    onChange={handleVideoUpload}
                    style={{ display: 'none' }}
                  />
                  <span className="upload-btn-text">Choose Video Manually</span>
                </label>
              </div>
            </div>
          )}

          {/* Instruction Panel */}
          <div className="instruction-panel">
            <div className="instruction-header">
              <h3>📋 Instructions</h3>
            </div>
            
            {/* Status Message */}
            <div className={`instruction-message ${instructionType}`}>
              <div className="message-icon">
                {instructionType === "positioning" && "⚠"}
                {instructionType === "confirming" && "⏳"}
                {instructionType === "ready" && "✓"}
                {instructionType === "feedback" && "💡"}
              </div>
              <div className="message-text">{instructionMessage}</div>
            </div>

            {/* Current Step Info */}
            {readyToStart && (
              <div className="step-info">
                <div className="step-current">
                  <strong>Current Step:</strong> {validationRules.steps[currentStepIndex].step_name}
                </div>
                <div className="step-description">
                  Time: {validationRules.steps[currentStepIndex].start_time}s - {validationRules.steps[currentStepIndex].end_time}s
                </div>
                
                {currentStepIndex < validationRules.steps.length - 1 && (
                  <div className="step-next">
                    <strong>Next:</strong> {validationRules.steps[currentStepIndex + 1].step_name}
                  </div>
                )}
                
                {currentStepIndex === validationRules.steps.length - 1 && (
                  <div className="step-complete">
                    🎉 Final Step - Almost Done!
                  </div>
                )}
              </div>
            )}

            {/* Metrics Display */}
            {readyToStart && (
              <div className="metrics-display">
                <h4>Real-time Metrics</h4>
                <div className="metric-row">
                  <span className="metric-label">Hip Angle:</span>
                  <span className="metric-value">{metrics.hip_angle.toFixed(0)}°</span>
                </div>
                <div className="metric-row">
                  <span className="metric-label">Knee Angle:</span>
                  <span className="metric-value">{metrics.knee_angle.toFixed(0)}°</span>
                </div>
                <div className="metric-row">
                  <span className="metric-label">Ankle Height:</span>
                  <span className="metric-value">{metrics.ankle_height.toFixed(2)}</span>
                </div>
                
                {/* Progress Bar */}
                <div className="progress-section">
                  <div className="progress-label">
                    Step {currentStepIndex + 1} of {validationRules.steps.length}
                  </div>
                  <div className="progress-bar-container">
                    <div 
                      className="progress-bar-fill" 
                      style={{ width: `${((currentStepIndex + 1) / validationRules.steps.length) * 100}%` }}
                    ></div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Camera Feed moved outside video-section to position fixed at bottom-right */}
      
      </div>

      <div className="controls">
        <button onClick={handleRestart} className="restart-btn">
          <span>🔄 Restart Exercise</span>
        </button>
        <button onClick={handleToggleVoice} className={`voice-btn ${voiceEnabled ? 'voice-on' : 'voice-off'}`}>
          <span>{voiceEnabled ? '🔊 Voice On' : '🔇 Voice Off'}</span>
        </button>
      </div>

      <div className="info-panel">
        <h2>{validationRules.exercise_name}</h2>
        <div className={`status-badge ${readyToStart ? 'ready' : 'positioning'}`}>
          {readyToStart ? '✓ Exercise Active' : '⚠ Position Yourself'}
        </div>
        <p>Current Step: <strong>{validationRules.steps[currentStepIndex].step_name}</strong></p>
        <p className="description">Step {currentStepIndex + 1} of {validationRules.steps.length}</p>
      </div>

      {/* Your Camera Feed - Fixed Bottom Right */}
      <div className="video-container">
        <div className="video-header">
          <h3>🎥 You</h3>
          <div className={`status-indicator ${readyToStart ? 'active' : 'inactive'}`}>
            {readyToStart ? '●' : '○'}
          </div>
        </div>
        <video ref={videoRef} className="video" width="280" height="210" autoPlay muted playsInline></video>
        <canvas ref={canvasRef} className="canvas" width="280" height="210"></canvas>
      </div>
    </div>
  );
}
