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
  const [metrics, setMetrics] = useState({ 
    left_hip_angle: 0, 
    left_knee_angle: 0, 
    left_ankle_height: 0,
    right_hip_angle: 0,
    right_knee_angle: 0,
    right_ankle_height: 0
  });
  const [feedback, setFeedback] = useState("");
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [isBodyVisible, setIsBodyVisible] = useState(false);
  const [readyToStart, setReadyToStart] = useState(false);
  const [exerciseStarted, setExerciseStarted] = useState(false); // Track if exercise has begun
  const [referenceVideoUrl, setReferenceVideoUrl] = useState(null);
  const [videoError, setVideoError] = useState(false);
  const referenceVideoRef = useRef(null);
  const videoStepTimesRef = useRef([]);
  const [instructionMessage, setInstructionMessage] = useState("Please position yourself so your shoulders, hips, and knees are visible.");
  const [instructionType, setInstructionType] = useState("positioning"); // positioning, confirming, ready, feedback
  const [cameraDistance, setCameraDistance] = useState(0);
  const [distanceStatus, setDistanceStatus] = useState("unknown"); // "too_close", "too_far", "good", "unknown"

  // Refs for stability and timing
  const landmarkBufferRef = useRef([]);
  const stableCounterRef = useRef(0);
  const currentStepIndexRef = useRef(0);
  const exerciseStartedRef = useRef(false); // Ref to track exercise state in pose callback
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

  // Sync refs with state
  useEffect(() => {
    currentStepIndexRef.current = currentStepIndex;
  }, [currentStepIndex]);

  useEffect(() => {
    exerciseStartedRef.current = exerciseStarted;
  }, [exerciseStarted]);

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
        speak("Please position yourself so your upper body and knees are visible in the camera.");
      }, 800);
    }
  }, [speak, voiceEnabled]);

  // Calculate camera distance from user (using z-coordinate)
  const calculateCameraDistance = useCallback((landmarks) => {
    // Use key body points to calculate average z-coordinate
    const keyPoints = [11, 12, 23, 24]; // Shoulders and hips
    let totalZ = 0;
    let count = 0;
    
    for (let idx of keyPoints) {
      if (landmarks[idx]) {
        totalZ += landmarks[idx].z;
        count++;
      }
    }
    
    return count > 0 ? totalZ / count : 0;
  }, []);

  // Check if camera distance is in ideal range
  const checkCameraDistance = useCallback((avgZ) => {
    const idealDistance = validationRules.ideal_camera_distance;
    if (!idealDistance) return "unknown";
    
    const buffer = 0.02; // 5cm buffer for flexibility
    
    if (avgZ < idealDistance.min_z - buffer) {
      return "too_close";
    } else if (avgZ > idealDistance.max_z + buffer) {
      return "too_far";
    } else {
      return "good";
    }
  }, []);

  // Check if all key body points are visible
  const checkBodyVisibility = useCallback((landmarks) => {
    const requiredPoints = [11, 12, 23, 24, 25, 26]; // Shoulders, hips, knees (ankles not required)
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

  // Step evaluation - handles both left and right sides
  const evaluateStep = useCallback((landmarks, stepRule) => {
    const L_SHOULDER = 11, L_HIP = 23, L_KNEE = 25, L_ANKLE = 27;
    const R_SHOULDER = 12, R_HIP = 24, R_KNEE = 26, R_ANKLE = 28;
    
    const l_shoulder = landmarks[L_SHOULDER];
    const l_hip = landmarks[L_HIP];
    const l_knee = landmarks[L_KNEE];
    const l_ankle = landmarks[L_ANKLE];
    
    const r_shoulder = landmarks[R_SHOULDER];
    const r_hip = landmarks[R_HIP];
    const r_knee = landmarks[R_KNEE];
    const r_ankle = landmarks[R_ANKLE];

    // Calculate angles for both sides
    const left_hip_angle = calculateAngle(l_shoulder, l_hip, l_knee);
    const left_knee_angle = calculateAngle(l_hip, l_knee, l_ankle);
    const left_ankle_height = l_ankle.y;
    
    const right_hip_angle = calculateAngle(r_shoulder, r_hip, r_knee);
    const right_knee_angle = calculateAngle(r_hip, r_knee, r_ankle);
    const right_ankle_height = r_ankle.y;

    const criteria = stepRule.criteria;
    let score = 0;
    const maxScore = 6; // 3 points per side

    // LEFT SIDE EVALUATION
    // Left hip angle
    if (criteria.left_hip_angle && criteria.left_hip_angle.expected) {
      const diff = Math.abs(left_hip_angle - criteria.left_hip_angle.expected);
      if (diff < 30) score += 1; // Within 30 degrees (increased from 20)
    }

    // Left knee angle - check if within expanded range
    if (criteria.left_knee_angle && criteria.left_knee_angle.min && criteria.left_knee_angle.max) {
      const kneeBuffer = 20; // Add 20 degrees buffer on both sides
      if (left_knee_angle >= criteria.left_knee_angle.min - kneeBuffer && 
          left_knee_angle <= criteria.left_knee_angle.max + kneeBuffer) {
        score += 1;
      }
    }

    // Left ankle height
    if (criteria.left_ankle_height && criteria.left_ankle_height.expected) {
      const heightDiff = Math.abs(left_ankle_height - criteria.left_ankle_height.expected);
      if (heightDiff < 0.25) score += 1; // Within 25% tolerance (increased from 15%)
    }

    // RIGHT SIDE EVALUATION
    // Right hip angle
    if (criteria.right_hip_angle && criteria.right_hip_angle.expected) {
      const diff = Math.abs(right_hip_angle - criteria.right_hip_angle.expected);
      if (diff < 30) score += 1; // Within 30 degrees (increased from 20)
    }

    // Right knee angle - check if within expanded range
    if (criteria.right_knee_angle && criteria.right_knee_angle.min && criteria.right_knee_angle.max) {
      const kneeBuffer = 20; // Add 20 degrees buffer on both sides
      if (right_knee_angle >= criteria.right_knee_angle.min - kneeBuffer && 
          right_knee_angle <= criteria.right_knee_angle.max + kneeBuffer) {
        score += 1;
      }
    }

    // Right ankle height
    if (criteria.right_ankle_height && criteria.right_ankle_height.expected) {
      const heightDiff = Math.abs(right_ankle_height - criteria.right_ankle_height.expected);
      if (heightDiff < 0.25) score += 1; // Within 25% tolerance (increased from 15%)
    }

    return { 
      score, 
      maxScore,
      metrics: { 
        left_hip_angle, 
        left_knee_angle, 
        left_ankle_height,
        right_hip_angle,
        right_knee_angle,
        right_ankle_height
      } 
    };
  }, [calculateAngle]);

  // Feedback logic - handles both left and right sides
  const getFeedbackMessage = useCallback((metrics, stepRule) => {
    const c = stepRule.criteria;
    
    // Check left knee angle with expanded buffer
    if (c.left_knee_angle && c.left_knee_angle.min && c.left_knee_angle.max) {
      const kneeBuffer = 30; // Increased buffer for feedback
      if (metrics.left_knee_angle < c.left_knee_angle.min - kneeBuffer) {
        return "Bend your left knee more!";
      }
      if (metrics.left_knee_angle > c.left_knee_angle.max + kneeBuffer) {
        return "Straighten your left knee!";
      }
    }
    
    // Check right knee angle with expanded buffer
    if (c.right_knee_angle && c.right_knee_angle.min && c.right_knee_angle.max) {
      const kneeBuffer = 30; // Increased buffer for feedback
      if (metrics.right_knee_angle < c.right_knee_angle.min - kneeBuffer) {
        return "Bend your right knee more!";
      }
      if (metrics.right_knee_angle > c.right_knee_angle.max + kneeBuffer) {
        return "Straighten your right knee!";
      }
    }
    
    // Check left ankle height with increased tolerance
    if (c.left_ankle_height && c.left_ankle_height.expected) {
      const heightDiff = Math.abs(metrics.left_ankle_height - c.left_ankle_height.expected);
      if (heightDiff > 0.35) { // Increased from 0.2 to 0.35
        if (metrics.left_ankle_height > c.left_ankle_height.expected) {
          return "Raise your left leg higher!";
        } else {
          return "Lower your left leg slightly!";
        }
      }
    }
    
    // Check right ankle height with increased tolerance
    if (c.right_ankle_height && c.right_ankle_height.expected) {
      const heightDiff = Math.abs(metrics.right_ankle_height - c.right_ankle_height.expected);
      if (heightDiff > 0.35) { // Increased from 0.2 to 0.35
        if (metrics.right_ankle_height > c.right_ankle_height.expected) {
          return "Raise your right leg higher!";
        } else {
          return "Lower your right leg slightly!";
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
          
          // Calculate and check camera distance
          const avgZ = calculateCameraDistance(rawLandmarks);
          setCameraDistance(avgZ);
          const distStatus = checkCameraDistance(avgZ);
          setDistanceStatus(distStatus);
          
          // Update visibility state
          if (bodyVisible) {
            // Check distance first before confirming ready
            if (distStatus === "too_close") {
              visibilityCheckFramesRef.current = 0;
              setInstructionMessage("⚠ Please step back - You're too close to the camera");
              setInstructionType("positioning");
              setReadyToStart(false);
              setIsBodyVisible(false);
              
              const now = Date.now();
              if (now - lastVisibilityWarningRef.current > VISIBILITY_WARNING_INTERVAL) {
                speak("Please step back. You are too close to the camera.");
                lastVisibilityWarningRef.current = now;
              }
            } else if (distStatus === "too_far") {
              visibilityCheckFramesRef.current = 0;
              setInstructionMessage("⚠ Please move closer - You're too far from the camera");
              setInstructionType("positioning");
              setReadyToStart(false);
              setIsBodyVisible(false);
              
              const now = Date.now();
              if (now - lastVisibilityWarningRef.current > VISIBILITY_WARNING_INTERVAL) {
                speak("Please move closer to the camera.");
                lastVisibilityWarningRef.current = now;
              }
            } else {
              // Distance is good, proceed with visibility check
              visibilityCheckFramesRef.current++;
              
              // If exercise hasn't started yet, need confirmation period
              if (!exerciseStartedRef.current) {
                const progress = Math.min(visibilityCheckFramesRef.current / 30, 1);
                setInstructionMessage(`Hold still... ${Math.round(progress * 100)}% confirmed`);
                setInstructionType("confirming");
                
                if (visibilityCheckFramesRef.current > 30 && !readyToStart) {
                  setReadyToStart(true);
                  setIsBodyVisible(true);
                  setExerciseStarted(true);
                  exerciseStartedRef.current = true;
                  setInstructionType("ready");
                  setInstructionMessage(`Starting: ${validationRules.steps[0].step_name}`);
                  speak(`Good! Let's start. Step 1: ${validationRules.steps[0].step_name}`);
                  
                  // Start the video
                  if (referenceVideoRef.current && referenceVideoUrl) {
                    referenceVideoRef.current.play().catch(err => {
                      console.log("Video autoplay prevented:", err);
                    });
                  }
                }
              } else {
                // Exercise already started, just mark body as visible again
                setIsBodyVisible(true);
                if (!readyToStart) {
                  setReadyToStart(true);
                  setInstructionMessage(`Continuing: ${validationRules.steps[currentStepIndexRef.current].step_name}`);
                  setInstructionType("ready");
                  
                  // Resume video from where it was paused
                  if (referenceVideoRef.current && referenceVideoUrl && referenceVideoRef.current.paused) {
                    referenceVideoRef.current.play().catch(err => {
                      console.log("Video resume error:", err);
                    });
                  }
                }
              }
            }
          } else {
            visibilityCheckFramesRef.current = 0;
            
            // If exercise hasn't started, show initial message
            if (!exerciseStartedRef.current) {
              setInstructionMessage("⚠ Step Back - Upper body and knees need to be visible");
              setInstructionType("positioning");
              setReadyToStart(false);
              setIsBodyVisible(false);
            } else {
              // Exercise started but body went out of frame - pause video but don't restart
              setInstructionMessage("⚠ Key body parts not visible - Please adjust your position");
              setInstructionType("positioning");
              setReadyToStart(false);
              setIsBodyVisible(false);
              
              // Pause video at current position
              if (referenceVideoRef.current && !referenceVideoRef.current.paused) {
                referenceVideoRef.current.pause();
              }
            }
            
            // Voice warning every 10 seconds
            const now = Date.now();
            if (now - lastVisibilityWarningRef.current > VISIBILITY_WARNING_INTERVAL) {
              speak("Please adjust your position. Your upper body and knees need to be visible.");
              lastVisibilityWarningRef.current = now;
            }
          }

          // Draw skeleton - mirrored to match video, thicker and more visible
          ctx.save();
          ctx.translate(canvasRef.current.width, 0);
          ctx.scale(-1, 1);
          
          // Bright, vibrant colors like in the reference image
          const skeletonColor = bodyVisible ? "#00FF00" : "#FF9800";  // Bright neon green
          const landmarkColor = bodyVisible ? "#00FF00" : "#FFB300";   // Bright neon green
          
          // Draw connections (skeleton lines) - thick like in reference image
          drawConnectors(ctx, rawLandmarks, POSE_CONNECTIONS, { 
            color: skeletonColor, 
            lineWidth: 12  // Very thick lines for high visibility
          });
          
          // Draw landmark points - visible dots at joints
          drawLandmarks(ctx, rawLandmarks, { 
            color: landmarkColor, 
            fillColor: landmarkColor,
            lineWidth: 3,
            radius: 8  // Larger dots for better visibility
          });
          
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

          // Stable pose → advance (with video synchronization)
          // Reduced score requirement to 3 out of 6 for easier progression
          if (score >= 3) {
            stableCounterRef.current++;
            setInstructionType("ready");
            setInstructionMessage("✓ Great form! Keep holding...");
            
            // Check if we can advance to next step
            if (stableCounterRef.current >= REQUIRED_STABLE_FRAMES && stepIndex < validationRules.steps.length - 1) {
              // Get current video time
              const currentVideoTime = referenceVideoRef.current ? referenceVideoRef.current.currentTime : 0;
              const nextStep = validationRules.steps[stepIndex + 1];
              const currentStep = validationRules.steps[stepIndex];
              
              // For step 1, allow advancement as soon as video reaches step 2 start time
              // Video continues playing, so just check if we're past current step end time
              if (currentVideoTime >= currentStep.end_time) {
                stableCounterRef.current = 0;
                currentStepIndexRef.current++;
                setCurrentStepIndex(prev => prev + 1);
                setInstructionMessage(`Next: ${nextStep.step_name}`);
                speak(`Good job! Now ${nextStep.step_name}`);
                lastSpokenStepRef.current = nextStep.step_name;
              } else {
                // Pose is good but video not at end of current step yet
                const timeLeft = Math.round(currentStep.end_time - currentVideoTime);
                if (timeLeft > 0) {
                  setInstructionMessage(`✓ Perfect! Hold for ${timeLeft} more seconds...`);
                }
              }
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
        height: 640,
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
    exerciseStartedRef.current = false; // Reset exercise started ref
    setCurrentStepIndex(0);
    setFeedback("");
    setReadyToStart(false);
    setIsBodyVisible(false);
    setExerciseStarted(false); // Reset exercise started flag
    landmarkBufferRef.current = [];
    setInstructionMessage("Please position yourself so your shoulders, hips, and knees are visible.");
    setInstructionType("positioning");
    
    // Reset reference video to start
    if (referenceVideoRef.current) {
      referenceVideoRef.current.currentTime = 0;
      referenceVideoRef.current.pause();
    }
    
    speak("Restarting. Please ensure your upper body and knees are visible.");
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

  // Handle video time update - let video play continuously, don't pause at step boundaries
  const handleVideoTimeUpdate = () => {
    // Video plays continuously through all steps
    // No pausing at step boundaries - only pause when body not visible
    return;
  };

  // Ensure video continues playing when user advances to next step
  React.useEffect(() => {
    if (referenceVideoRef.current && referenceVideoUrl && currentStepIndex > 0) {
      // Just ensure video is playing, don't jump to different time
      if (referenceVideoRef.current.paused) {
        referenceVideoRef.current.play().catch(err => {
          console.log("Video play error:", err);
        });
      }
    }
  }, [currentStepIndex, referenceVideoUrl]);

  return (
    <div className="app-container">
      <div className="app-header">
        <h1>M2 Method Exercise Instructor</h1>
        <p>Real-time pose detection and guidance</p>
      </div>

      <div className="video-section">
        <div className="video-and-instructions">
          {/* Reference Video */}
          {referenceVideoUrl ? (
            <div className="reference-video-container">
              <div className="video-header">
                <h3>▶️ Reference Video</h3>
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
                <div className="upload-icon">🎬</div>
                <h3>No Reference Video</h3>
                <p>Place video in <code>public/videos/</code> folder</p>
                <p className="video-names">Supported: a4.mov, exercise.mp4, demo.mp4, video.mp4</p>
                <div className="upload-divider">OR</div>
                <label className="upload-label">
                  <input 
                    type="file" 
                    accept="video/*" 
                    onChange={handleVideoUpload}
                    style={{ display: 'none' }}
                  />
                  <span className="upload-btn-text">📁 Choose Video</span>
                </label>
              </div>
            </div>
          )}

          {/* Instruction Panel */}
          <div className="instruction-panel">
            <div className="instruction-header">
              <h3>📝 Live Instructions</h3>
            </div>
            
            {/* Status Message */}
            <div className={`instruction-message ${instructionType}`}>
              <div className="message-icon">
                {instructionType === "positioning" && "⚠️"}
                {instructionType === "confirming" && "⏱️"}
                {instructionType === "ready" && "✅"}
                {instructionType === "feedback" && "💬"}
              </div>
              <div className="message-text">{instructionMessage}</div>
            </div>

            {/* Camera Distance Indicator */}
            <div className={`distance-indicator ${distanceStatus}`}>
              <div className="distance-icon">
                {distanceStatus === "too_close" && "🔴"}
                {distanceStatus === "too_far" && "🟡"}
                {distanceStatus === "good" && "🟢"}
                {distanceStatus === "unknown" && "⚪"}
              </div>
              <div className="distance-info">
                <span className="distance-label">Body distance from camera:</span>
                <span className="distance-value">
                  {distanceStatus === "too_close" && "Too Close"}
                  {distanceStatus === "too_far" && "Too Far"}
                  {distanceStatus === "good" && "Perfect"}
                  {distanceStatus === "unknown" && "Detecting..."}
                </span>
                <span className="distance-metric">({cameraDistance.toFixed(3)})</span>
              </div>
            </div>

            {/* Current Step Info */}
            {readyToStart && (
              <div className="step-info">
                <div className="step-badge">
                  Step {currentStepIndex + 1}/{validationRules.steps.length}
                </div>
                <div className="step-current">
                  <span className="step-icon">🎯</span>
                  <strong>{validationRules.steps[currentStepIndex].step_name}</strong>
                </div>
                <div className="step-description">
                  ⏱️ {validationRules.steps[currentStepIndex].start_time}s - {validationRules.steps[currentStepIndex].end_time}s
                </div>
                
                {currentStepIndex < validationRules.steps.length - 1 && (
                  <div className="step-next">
                    <span className="next-icon">▶️</span> {validationRules.steps[currentStepIndex + 1].step_name}
                  </div>
                )}
                
                {currentStepIndex === validationRules.steps.length - 1 && (
                  <div className="step-complete">
                    🏆 Final Step - Almost Done!
                  </div>
                )}
              </div>
            )}

            {/* Metrics Display */}
            {readyToStart && (
              <div className="metrics-display">
                <h4>📊 Live Metrics</h4>
                <div className="metrics-grid">
                  {/* Left Knee Angle with Range */}
                  <div className="metric-item">
                    <div className="metric-icon knee">🟢</div>
                    <div className="metric-content">
                      <span className="metric-label">Left Knee Angle</span>
                      <span className="metric-value">{metrics.left_knee_angle.toFixed(0)}°</span>
                    </div>
                  </div>
                  {validationRules.steps[currentStepIndex]?.criteria?.left_knee_angle && (
                    <div className="metric-range">
                      Acceptable: {(validationRules.steps[currentStepIndex].criteria.left_knee_angle.min - 20).toFixed(0)}° - {(validationRules.steps[currentStepIndex].criteria.left_knee_angle.max + 20).toFixed(0)}°
                    </div>
                  )}
                  
                  {/* Right Knee Angle with Range */}
                  <div className="metric-item">
                    <div className="metric-icon knee">🟢</div>
                    <div className="metric-content">
                      <span className="metric-label">Right Knee Angle</span>
                      <span className="metric-value">{metrics.right_knee_angle.toFixed(0)}°</span>
                    </div>
                  </div>
                  {validationRules.steps[currentStepIndex]?.criteria?.right_knee_angle && (
                    <div className="metric-range">
                      Acceptable: {(validationRules.steps[currentStepIndex].criteria.right_knee_angle.min - 20).toFixed(0)}° - {(validationRules.steps[currentStepIndex].criteria.right_knee_angle.max + 20).toFixed(0)}°
                    </div>
                  )}
                  
                  {/* Left Ankle Height with Range */}
                  <div className="metric-item">
                    <div className="metric-icon ankle">🟡</div>
                    <div className="metric-content">
                      <span className="metric-label">Left Ankle Height</span>
                      <span className="metric-value">{metrics.left_ankle_height.toFixed(2)}</span>
                    </div>
                  </div>
                  {validationRules.steps[currentStepIndex]?.criteria?.left_ankle_height && (
                    <div className="metric-range">
                      Target: {(validationRules.steps[currentStepIndex].criteria.left_ankle_height.expected).toFixed(2)} (±0.25)
                    </div>
                  )}
                  
                  {/* Right Ankle Height with Range */}
                  <div className="metric-item">
                    <div className="metric-icon ankle">🟡</div>
                    <div className="metric-content">
                      <span className="metric-label">Right Ankle Height</span>
                      <span className="metric-value">{metrics.right_ankle_height.toFixed(2)}</span>
                    </div>
                  </div>
                  {validationRules.steps[currentStepIndex]?.criteria?.right_ankle_height && (
                    <div className="metric-range">
                      Target: {(validationRules.steps[currentStepIndex].criteria.right_ankle_height.expected).toFixed(2)} (±0.25)
                    </div>
                  )}
                </div>
                
                {/* Progress Bar */}
                <div className="progress-section">
                  <div className="progress-label">
                    Overall Progress: {Math.round(((currentStepIndex + 1) / validationRules.steps.length) * 100)}%
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

      {/* Controls and Info Row */}
      <div className="bottom-section">
        <div className="exercise-info-card">
          <div className="exercise-title">
            <h2>Exercise: {validationRules.exercise_name}</h2>
          </div>
          <div className={`status-badge ${readyToStart ? 'ready' : 'positioning'}`}>
            {readyToStart ? '✅ Active' : '⚠️ Position Required'}
          </div>
        </div>

        <div className="controls">
          <button onClick={handleRestart} className="restart-btn">
            <span className="btn-icon">↻</span>
            <span className="btn-text">Restart</span>
          </button>
          <button onClick={handleToggleVoice} className={`voice-btn ${voiceEnabled ? 'voice-on' : 'voice-off'}`}>
            <span className="btn-icon">{voiceEnabled ? '🔊' : '🔇'}</span>
            <span className="btn-text">{voiceEnabled ? 'Voice On' : 'Voice Off'}</span>
          </button>
        </div>
      </div>

      {/* Your Camera Feed - Fixed Bottom Right */}
      <div className="video-container">
        <div className="video-header">
          <h3>📷 Your Feed</h3>
          <div className={`status-indicator ${readyToStart ? 'active' : 'inactive'}`}>
            {readyToStart ? '●' : '○'}
          </div>
        </div>
        <video 
          ref={videoRef} 
          className="video" 
          width="640" 
          height="640" 
          autoPlay 
          muted 
          playsInline 
          crossOrigin="anonymous"
          style={{ opacity: 1, visibility: 'visible' }}
        ></video>
        <canvas ref={canvasRef} className="canvas" width="640" height="640"></canvas>
      </div>
    </div>
  );
}
