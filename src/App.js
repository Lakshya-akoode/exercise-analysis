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
    left_ankle_angle: 0,
    left_elbow_angle: 0,
    left_shoulder_angle: 0,
    right_hip_angle: 0,
    right_knee_angle: 0,
    right_ankle_angle: 0,
    right_elbow_angle: 0,
    right_shoulder_angle: 0,
    ankle_height: 0,
    knee_height: 0,
    hip_height: 0,
    shoulder_height: 0,
    back_flatness_deviation: 0
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
  const FEEDBACK_COOLDOWN = 15000; // 15 seconds - increased to reduce frequency
  const VISIBILITY_WARNING_INTERVAL = 15000; // 15 seconds - increased to reduce frequency

  // Sync refs with state
  useEffect(() => {
    currentStepIndexRef.current = currentStepIndex;
  }, [currentStepIndex]);

  useEffect(() => {
    exerciseStartedRef.current = exerciseStarted;
  }, [exerciseStarted]);

  // Voice function - with video audio handling
  const speak = useCallback((text) => {
    if (voiceEnabled && 'speechSynthesis' in window) {
      speechSynthesis.cancel();
      
      // Lower video volume when speaking to avoid overlap
      const video = referenceVideoRef.current;
      let originalVolume = 1.0;
      if (video) {
        originalVolume = video.volume;
        video.volume = 0.2; // Lower video volume to 20% when speaking
      }
      
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.9; // Slightly slower for clarity
      utterance.volume = 0.8; // Slightly lower volume to be less distracting

      const loadVoices = () => {
        const voices = speechSynthesis.getVoices();
        const female = voices.find(v => 
          v.name.toLowerCase().includes("female") ||
          v.name.toLowerCase().includes("zira") ||
          v.name.toLowerCase().includes("samantha")
        );
        if (female) utterance.voice = female;
        
        // Restore video volume when speech ends
        utterance.onend = () => {
          if (video) {
            video.volume = originalVolume;
          }
        };
        
        utterance.onerror = () => {
          if (video) {
            video.volume = originalVolume;
          }
        };
        
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

  // Calculate back flatness deviation
  // Returns the maximum deviation from a flat back (0 = perfectly flat)
  // When sitting, shoulders are much higher than hips, so deviation is large
  const calculateBackFlatness = useCallback((landmarks) => {
    const L_SHOULDER = 11, R_SHOULDER = 12;
    const L_HIP = 23, R_HIP = 24;
    
    const l_shoulder = landmarks[L_SHOULDER];
    const r_shoulder = landmarks[R_SHOULDER];
    const l_hip = landmarks[L_HIP];
    const r_hip = landmarks[R_HIP];
    
    if (!l_shoulder || !r_shoulder || !l_hip || !r_hip) return 1.0; // Invalid if missing
    
    // Calculate average shoulder and hip positions
    const avgShoulderY = (l_shoulder.y + r_shoulder.y) / 2;
    const avgHipY = (l_hip.y + r_hip.y) / 2;
    
    // Primary check: Vertical deviation between shoulders and hips
    // When lying flat, shoulders and hips should be at similar Y positions
    // When sitting, shoulders are much higher (lower Y value) than hips
    const verticalDeviation = Math.abs(avgShoulderY - avgHipY);
    
    // Additional check: Individual shoulder/hip alignment (lateral tilt)
    const shoulderDeviation = Math.abs(l_shoulder.y - r_shoulder.y);
    const hipDeviation = Math.abs(l_hip.y - r_hip.y);
    
    // For lying down, we also check if shoulders are too high (sitting position)
    // If shoulders are significantly above hips (lower Y value), person is sitting
    const shoulderAboveHip = avgShoulderY < avgHipY; // Lower Y = higher on screen
    const sittingIndicator = shoulderAboveHip ? (avgHipY - avgShoulderY) * 2 : 0; // Penalize sitting more
    
    // Maximum deviation - prioritize vertical deviation and sitting detection
    const maxDeviation = Math.max(
      verticalDeviation + sittingIndicator, // Main check with sitting penalty
      shoulderDeviation * 0.5, // Lateral tilt is less critical
      hipDeviation * 0.5
    );
    
    return maxDeviation;
  }, []);

  // Step evaluation - uses new statistical ranges with lenient thresholds
  const evaluateStep = useCallback((landmarks, stepRule) => {
    const L_SHOULDER = 11, L_HIP = 23, L_KNEE = 25, L_ANKLE = 27;
    const R_SHOULDER = 12, R_HIP = 24, R_KNEE = 26, R_ANKLE = 28;
    const L_ELBOW = 13, R_ELBOW = 14, L_WRIST = 15, R_WRIST = 16;
    const L_FOOT_INDEX = 31, R_FOOT_INDEX = 32;
    const NOSE = 0, L_EAR = 7, R_EAR = 8;
    
    const l_shoulder = landmarks[L_SHOULDER];
    const l_hip = landmarks[L_HIP];
    const l_knee = landmarks[L_KNEE];
    const l_ankle = landmarks[L_ANKLE];
    const l_elbow = landmarks[L_ELBOW];
    const l_wrist = landmarks[L_WRIST];
    const l_foot_index = landmarks[L_FOOT_INDEX];
    
    const r_shoulder = landmarks[R_SHOULDER];
    const r_hip = landmarks[R_HIP];
    const r_knee = landmarks[R_KNEE];
    const r_ankle = landmarks[R_ANKLE];
    const r_elbow = landmarks[R_ELBOW];
    const r_wrist = landmarks[R_WRIST];
    const r_foot_index = landmarks[R_FOOT_INDEX];
    
    const nose = landmarks[NOSE];
    const l_ear = landmarks[L_EAR];
    const r_ear = landmarks[R_EAR];

    // Calculate angles for both sides
    const left_hip_angle = calculateAngle(l_shoulder, l_hip, l_knee);
    const left_knee_angle = calculateAngle(l_hip, l_knee, l_ankle);
    // Ankle angle: knee-ankle-foot_index
    const left_ankle_angle = l_knee && l_ankle && l_foot_index ? calculateAngle(l_knee, l_ankle, l_foot_index) : 0;
    // Elbow angle: shoulder-elbow-wrist
    const left_elbow_angle = l_shoulder && l_elbow && l_wrist ? calculateAngle(l_shoulder, l_elbow, l_wrist) : 0;
    // Shoulder angle: hip-shoulder-elbow
    const left_shoulder_angle = l_hip && l_shoulder && l_elbow ? calculateAngle(l_hip, l_shoulder, l_elbow) : 0;
    
    const right_hip_angle = calculateAngle(r_shoulder, r_hip, r_knee);
    const right_knee_angle = calculateAngle(r_hip, r_knee, r_ankle);
    // Ankle angle: knee-ankle-foot_index
    const right_ankle_angle = r_knee && r_ankle && r_foot_index ? calculateAngle(r_knee, r_ankle, r_foot_index) : 0;
    // Elbow angle: shoulder-elbow-wrist
    const right_elbow_angle = r_shoulder && r_elbow && r_wrist ? calculateAngle(r_shoulder, r_elbow, r_wrist) : 0;
    // Shoulder angle: hip-shoulder-elbow
    const right_shoulder_angle = r_hip && r_shoulder && r_elbow ? calculateAngle(r_hip, r_shoulder, r_elbow) : 0;
    
    // Calculate average ankle height (both ankles)
    const ankle_height = l_ankle && r_ankle ? (l_ankle.y + r_ankle.y) / 2 : (l_ankle?.y || r_ankle?.y || 0);
    
    // Calculate average knee height
    const knee_height = l_knee && r_knee ? (l_knee.y + r_knee.y) / 2 : (l_knee?.y || r_knee?.y || 0);
    
    // Calculate average hip height
    const hip_height = l_hip && r_hip ? (l_hip.y + r_hip.y) / 2 : (l_hip?.y || r_hip?.y || 0);
    
    // Calculate average shoulder height
    const shoulder_height = l_shoulder && r_shoulder ? (l_shoulder.y + r_shoulder.y) / 2 : (l_shoulder?.y || r_shoulder?.y || 0);
    
    // Calculate hip width (distance between hips)
    const hip_width = l_hip && r_hip ? Math.abs(l_hip.x - r_hip.x) : 0;
    
    // Calculate shoulder width
    const shoulder_width = l_shoulder && r_shoulder ? Math.abs(l_shoulder.x - r_shoulder.x) : 0;
    
    // Calculate head tilt angle (angle between nose and ears)
    const head_tilt_angle = nose && l_ear && r_ear ? calculateAngle(l_ear, nose, r_ear) : 0;
    
    // Calculate spine angle (angle between shoulders and hips)
    const spine_angle = l_shoulder && r_shoulder && l_hip && r_hip ? 
      calculateAngle(l_shoulder, l_hip, r_hip) : 0;
    
    // Calculate torso angle (angle between shoulders and hips, different calculation)
    const torso_angle = l_shoulder && r_shoulder && l_hip && r_hip ?
      calculateAngle(r_shoulder, l_shoulder, l_hip) : 0;

    const criteria = stepRule.criteria;
    let score = 0;
    let maxScore = 0;

    // Helper function to check if value is within range with lenient buffer
    // Uses min/max from JSON with percentage-based buffer for leniency
    const checkRange = (value, criterion, useLargerBuffer = false) => {
      if (!criterion || !criterion.min || !criterion.max) return false;
      
      // Calculate the range (max - min)
      const range = criterion.max - criterion.min;
      
      // For knee angles, use 15% of range as buffer (more lenient)
      // For other metrics, use 10% of range as buffer
      const bufferPercent = useLargerBuffer ? 0.15 : 0.10;
      const buffer = range * bufferPercent;
      
      // Check if value is within min-max range with buffer
      return value >= (criterion.min - buffer) && value <= (criterion.max + buffer);
    };

    // Check left hip angle
    if (criteria.left_hip_angle) {
      maxScore++;
      if (checkRange(left_hip_angle, criteria.left_hip_angle)) {
        score++;
      }
    }

    // Check left knee angle - MORE LENIENT (use 2*std buffer)
    if (criteria.left_knee_angle) {
      maxScore++;
      if (checkRange(left_knee_angle, criteria.left_knee_angle, true)) {
        score++;
      }
    }

    // Check right hip angle
    if (criteria.right_hip_angle) {
      maxScore++;
      if (checkRange(right_hip_angle, criteria.right_hip_angle)) {
        score++;
      }
    }

    // Check right knee angle - MORE LENIENT (use 2*std buffer)
    if (criteria.right_knee_angle) {
      maxScore++;
      if (checkRange(right_knee_angle, criteria.right_knee_angle, true)) {
        score++;
      }
    }

    // Check left ankle angle
    if (criteria.left_ankle_angle) {
      maxScore++;
      if (checkRange(left_ankle_angle, criteria.left_ankle_angle)) {
        score++;
      }
    }

    // Check right ankle angle
    if (criteria.right_ankle_angle) {
      maxScore++;
      if (checkRange(right_ankle_angle, criteria.right_ankle_angle)) {
        score++;
      }
    }

    // Check left elbow angle
    if (criteria.left_elbow_angle) {
      maxScore++;
      if (checkRange(left_elbow_angle, criteria.left_elbow_angle)) {
        score++;
      }
    }

    // Check right elbow angle
    if (criteria.right_elbow_angle) {
      maxScore++;
      if (checkRange(right_elbow_angle, criteria.right_elbow_angle)) {
        score++;
      }
    }

    // Check left shoulder angle
    if (criteria.left_shoulder_angle) {
      maxScore++;
      if (checkRange(left_shoulder_angle, criteria.left_shoulder_angle)) {
        score++;
      }
    }

    // Check right shoulder angle
    if (criteria.right_shoulder_angle) {
      maxScore++;
      if (checkRange(right_shoulder_angle, criteria.right_shoulder_angle)) {
        score++;
      }
    }

    // Check ankle height
    if (criteria.ankle_height) {
      maxScore++;
      if (checkRange(ankle_height, criteria.ankle_height)) {
        score++;
      }
    }

    // Check knee height
    if (criteria.knee_height) {
      maxScore++;
      if (checkRange(knee_height, criteria.knee_height)) {
        score++;
      }
    }

    // Check hip height
    if (criteria.hip_height) {
      maxScore++;
      if (checkRange(hip_height, criteria.hip_height)) {
        score++;
      }
    }

    // Check shoulder height
    if (criteria.shoulder_height) {
      maxScore++;
      if (checkRange(shoulder_height, criteria.shoulder_height)) {
        score++;
      }
    }

    // Check back flatness if required
    const backFlat = stepRule.back_flat;
    const backFlatnessDeviation = calculateBackFlatness(landmarks);
    let backFlatPassed = true;
    if (backFlat && backFlat.should_be_flat) {
      maxScore++;
      // Back is flat if deviation is within max_deviation threshold
      if (backFlatnessDeviation <= backFlat.max_deviation) {
        score++;
        backFlatPassed = true;
      } else {
        // Back flatness is REQUIRED - if it fails, significantly penalize the score
        // This ensures sitting positions are not accepted
        backFlatPassed = false;
        // Reduce score by 30% to make it harder to pass without flat back
        score = Math.floor(score * 0.7);
      }
    }

    return { 
      score, 
      maxScore: Math.max(maxScore, 1), // Ensure at least 1
      metrics: { 
        left_hip_angle, 
        left_knee_angle,
        left_ankle_angle,
        left_elbow_angle,
        left_shoulder_angle,
        right_hip_angle,
        right_knee_angle,
        right_ankle_angle,
        right_elbow_angle,
        right_shoulder_angle,
        ankle_height,
        knee_height,
        hip_height,
        shoulder_height,
        back_flatness_deviation: backFlatnessDeviation
      } 
    };
  }, [calculateAngle, calculateBackFlatness]);

  // Feedback logic - uses new statistical ranges with lenient thresholds
  const getFeedbackMessage = useCallback((metrics, stepRule) => {
    // Skip feedback for step 1 (start_position)
    if (stepRule.step_number === 1) {
      return "";
    }
    
    const c = stepRule.criteria;
    
    // Helper to check if value is outside range with buffer
    // Uses min/max from JSON with percentage-based buffer for feedback
    const isOutsideRange = (value, criterion, useLargerBuffer = false) => {
      if (!criterion || !criterion.min || !criterion.max) return null;
      
      // Calculate the range (max - min)
      const range = criterion.max - criterion.min;
      
      // For knee angles, use 20% of range as buffer for feedback (more lenient before feedback)
      // For other metrics, use 15% of range as buffer
      const bufferPercent = useLargerBuffer ? 0.20 : 0.15;
      const buffer = range * bufferPercent;
      
      const min = criterion.min - buffer;
      const max = criterion.max + buffer;
      
      if (value < min) return "too_low";
      if (value > max) return "too_high";
      return null;
    };
    
    // PRIORITY CHECK: Back flatness (highest priority when required)
    const backFlat = stepRule.back_flat;
    if (backFlat && backFlat.should_be_flat) {
      if (metrics.back_flatness_deviation > backFlat.max_deviation) {
        return "⚠️ Lie down flat! Keep your back flat on the ground!";
      }
    }
    
    // Check left knee angle - MORE LENIENT (use 2.5*std buffer for feedback)
    if (c.left_knee_angle) {
      const status = isOutsideRange(metrics.left_knee_angle, c.left_knee_angle, true);
      if (status === "too_low") {
        return "Bend your left knee more!";
      }
      if (status === "too_high") {
        return "Straighten your left knee!";
      }
    }
    
    // Check right knee angle - MORE LENIENT (use 2.5*std buffer for feedback)
    if (c.right_knee_angle) {
      const status = isOutsideRange(metrics.right_knee_angle, c.right_knee_angle, true);
      if (status === "too_low") {
        return "Bend your right knee more!";
      }
      if (status === "too_high") {
        return "Straighten your right knee!";
      }
    }
    
    // Check ankle height (average of both ankles)
    if (c.ankle_height) {
      const status = isOutsideRange(metrics.ankle_height, c.ankle_height);
      if (status === "too_low") {
        return "Raise your legs higher!";
      }
      if (status === "too_high") {
        return "Lower your legs slightly!";
      }
    }
    
    // Check knee height
    if (c.knee_height) {
      const status = isOutsideRange(metrics.knee_height, c.knee_height);
      if (status === "too_low") {
        return "Raise your knees higher!";
      }
      if (status === "too_high") {
        return "Lower your knees slightly!";
      }
    }
    
    // Check hip angles
    if (c.left_hip_angle) {
      const status = isOutsideRange(metrics.left_hip_angle, c.left_hip_angle);
      if (status) {
        return "Adjust your left hip position!";
      }
    }
    
    if (c.right_hip_angle) {
      const status = isOutsideRange(metrics.right_hip_angle, c.right_hip_angle);
      if (status) {
        return "Adjust your right hip position!";
      }
    }
    
    // Check ankle angles
    if (c.left_ankle_angle) {
      const status = isOutsideRange(metrics.left_ankle_angle, c.left_ankle_angle);
      if (status) {
        return "Adjust your left ankle position!";
      }
    }
    
    if (c.right_ankle_angle) {
      const status = isOutsideRange(metrics.right_ankle_angle, c.right_ankle_angle);
      if (status) {
        return "Adjust your right ankle position!";
      }
    }
    
    // Check elbow angles
    if (c.left_elbow_angle) {
      const status = isOutsideRange(metrics.left_elbow_angle, c.left_elbow_angle);
      if (status) {
        return "Adjust your left arm position!";
      }
    }
    
    if (c.right_elbow_angle) {
      const status = isOutsideRange(metrics.right_elbow_angle, c.right_elbow_angle);
      if (status) {
        return "Adjust your right arm position!";
      }
    }
    
    // Check shoulder angles
    if (c.left_shoulder_angle) {
      const status = isOutsideRange(metrics.left_shoulder_angle, c.left_shoulder_angle);
      if (status) {
        return "Adjust your left shoulder position!";
      }
    }
    
    if (c.right_shoulder_angle) {
      const status = isOutsideRange(metrics.right_shoulder_angle, c.right_shoulder_angle);
      if (status) {
        return "Adjust your right shoulder position!";
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

          // Check which step the video is currently in
          const currentVideoTime = referenceVideoRef.current ? referenceVideoRef.current.currentTime : 0;
          let videoStepIndex = currentStepIndexRef.current;
          for (let i = 0; i < validationRules.steps.length; i++) {
            const s = validationRules.steps[i];
            if (currentVideoTime >= s.start_time && currentVideoTime < s.end_time) {
              videoStepIndex = i;
              break;
            }
          }
          
          // ALWAYS evaluate user's pose against the video's current step
          // This ensures user must match what the video is showing
          const videoStep = validationRules.steps[videoStepIndex];
          const { score, maxScore, metrics: newMetrics } = evaluateStep(smoothed, videoStep);
          setMetrics(newMetrics);
          
          // Check back flatness - pause video if back isn't flat when required
          const backFlat = videoStep.back_flat;
          const backFlatFailed = backFlat && backFlat.should_be_flat && 
                                 newMetrics.back_flatness_deviation > backFlat.max_deviation;
          
          if (backFlatFailed && referenceVideoRef.current && !referenceVideoRef.current.paused) {
            // Pause video if back isn't flat
            referenceVideoRef.current.pause();
            setInstructionType("feedback");
            setInstructionMessage("⚠️ Video paused - Lie down flat! Keep your back flat on the ground!");
          } else if (!backFlatFailed && referenceVideoRef.current && referenceVideoRef.current.paused && exerciseStarted) {
            // Resume video when back becomes flat again
            referenceVideoRef.current.play().catch(err => {
              console.log("Video resume error:", err);
            });
          }
          
          // Use percentage-based threshold (40% of maxScore for passing)
          const passingThreshold = Math.ceil(maxScore * 0.4);
          const isPassing = score >= passingThreshold;
          
          const stepIndex = currentStepIndexRef.current;
          
          // If video is ahead of user's tracked step, they need to catch up
          if (videoStepIndex > stepIndex && referenceVideoRef.current && !referenceVideoRef.current.paused) {
            const stepName = videoStep.step_name.replace(/_/g, ' ');
            
            // If user's pose doesn't match the video's step, give feedback
            if (!isPassing) {
              setInstructionType("feedback");
              setInstructionMessage(`⚠️ Follow the video! ${stepName} - Your pose doesn't match yet.`);
              
              const now = Date.now();
              if (now - lastFeedbackTimeRef.current > FEEDBACK_COOLDOWN) {
                speak(`Follow the video. ${stepName}. Your pose doesn't match yet.`);
                lastFeedbackTimeRef.current = now;
              }
            } else if (isPassing) {
              // User is matching! Advance their step
              setInstructionType("ready");
              setInstructionMessage(`✓ Good! You're matching the video: ${stepName}`);
              currentStepIndexRef.current = videoStepIndex;
              setCurrentStepIndex(videoStepIndex);
              stableCounterRef.current = 0;
            }
            ctx.restore();
            return;
          }

          // Skip feedback for first 5s
          if (Date.now() - exerciseStartTime < 5000) {
            setInstructionType("ready");
            setInstructionMessage("Exercise in progress...");
            ctx.restore();
            return;
          }

          // Stable pose → advance (with video synchronization)
          // User must match the video's current step to advance
          // Use percentage-based threshold (40% of maxScore for passing)
          if (isPassing) {
            // User is matching the video's current step
            stableCounterRef.current++;
            setInstructionType("ready");
            setInstructionMessage("✓ Great form! Keep holding...");
            
            // Only advance if user is matching the video's step AND video has moved to next step
            if (stepIndex === videoStepIndex && stableCounterRef.current >= REQUIRED_STABLE_FRAMES) {
              // Check if video has moved to next step
              if (videoStepIndex < validationRules.steps.length - 1) {
                const nextStep = validationRules.steps[videoStepIndex + 1];
                const currentStep = validationRules.steps[videoStepIndex];
                
                // Only advance when video reaches next step's start time
                if (currentVideoTime >= nextStep.start_time) {
                  stableCounterRef.current = 0;
                  currentStepIndexRef.current = videoStepIndex + 1;
                  setCurrentStepIndex(videoStepIndex + 1);
                  setInstructionMessage(`Next: ${nextStep.step_name}`);
                  speak(`Good job! Now ${nextStep.step_name}`);
                  lastSpokenStepRef.current = nextStep.step_name;
                } else {
                  // Pose is good but video not at next step yet
                  const timeLeft = Math.round(nextStep.start_time - currentVideoTime);
                  if (timeLeft > 0) {
                    setInstructionMessage(`✓ Perfect! Hold for ${timeLeft} more seconds...`);
                  }
                }
              }
            } else if (stepIndex < videoStepIndex) {
              // User is behind - they need to catch up (handled above)
              stableCounterRef.current = 0;
            }
          } else {
            // Score is low - user doesn't match video's step
            stableCounterRef.current = 0;
          }

          // Only give feedback if score is low (user is actually doing something wrong)
          // This prevents false positives when user is in correct position
          // Use videoStep since we're always evaluating against what the video is showing
          if (!isPassing) {
            const fb = getFeedbackMessage(newMetrics, videoStep);
            setFeedback(fb);
            if (fb) {
              setInstructionType("feedback");
              setInstructionMessage(fb);
              
              const now = Date.now();
              if (now - lastFeedbackTimeRef.current > FEEDBACK_COOLDOWN) {
                speak(fb);
                lastFeedbackTimeRef.current = now;
              }
            } else {
              // Clear feedback if no message and score is improving
              setFeedback("");
              const improvingThreshold = Math.ceil(maxScore * 0.3);
              if (score >= improvingThreshold) {
                setInstructionType("ready");
                setInstructionMessage("Keep going, you're doing well!");
              }
            }
          } else {
            // Score is good (passing threshold), clear any previous feedback
            // Message already set above in the isPassing block
            setFeedback("");
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
                  {validationRules.steps[currentStepIndex]?.criteria?.left_knee_angle && (() => {
                    const crit = validationRules.steps[currentStepIndex].criteria.left_knee_angle;
                    const range = crit.max - crit.min;
                    const buffer = range * 0.15; // 15% buffer for knee angles
                    return (
                      <div className="metric-range">
                        Acceptable: {(crit.min - buffer).toFixed(0)}° - {(crit.max + buffer).toFixed(0)}°
                      </div>
                    );
                  })()}
                  
                  {/* Right Knee Angle with Range */}
                  <div className="metric-item">
                    <div className="metric-icon knee">🟢</div>
                    <div className="metric-content">
                      <span className="metric-label">Right Knee Angle</span>
                      <span className="metric-value">{metrics.right_knee_angle.toFixed(0)}°</span>
                    </div>
                  </div>
                  {validationRules.steps[currentStepIndex]?.criteria?.right_knee_angle && (() => {
                    const crit = validationRules.steps[currentStepIndex].criteria.right_knee_angle;
                    const range = crit.max - crit.min;
                    const buffer = range * 0.15; // 15% buffer for knee angles
                    return (
                      <div className="metric-range">
                        Acceptable: {(crit.min - buffer).toFixed(0)}° - {(crit.max + buffer).toFixed(0)}°
                      </div>
                    );
                  })()}
                  
                  {/* Ankle Height (Average) with Range */}
                  <div className="metric-item">
                    <div className="metric-icon ankle">🟡</div>
                    <div className="metric-content">
                      <span className="metric-label">Ankle Height</span>
                      <span className="metric-value">{metrics.ankle_height.toFixed(2)}</span>
                    </div>
                  </div>
                  {validationRules.steps[currentStepIndex]?.criteria?.ankle_height && (() => {
                    const crit = validationRules.steps[currentStepIndex].criteria.ankle_height;
                    const range = crit.max - crit.min;
                    const buffer = range * 0.10; // 10% buffer for other metrics
                    return (
                      <div className="metric-range">
                        Acceptable: {(crit.min - buffer).toFixed(2)} - {(crit.max + buffer).toFixed(2)}
                      </div>
                    );
                  })()}
                  
                  {/* Knee Height with Range */}
                  {validationRules.steps[currentStepIndex]?.criteria?.knee_height && (
                    <>
                      <div className="metric-item">
                        <div className="metric-icon knee">🟢</div>
                        <div className="metric-content">
                          <span className="metric-label">Knee Height</span>
                          <span className="metric-value">{metrics.knee_height.toFixed(2)}</span>
                        </div>
                      </div>
                      {(() => {
                        const crit = validationRules.steps[currentStepIndex].criteria.knee_height;
                        const range = crit.max - crit.min;
                        const buffer = range * 0.10; // 10% buffer for other metrics
                        return (
                          <div className="metric-range">
                            Acceptable: {(crit.min - buffer).toFixed(2)} - {(crit.max + buffer).toFixed(2)}
                          </div>
                        );
                      })()}
                    </>
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
