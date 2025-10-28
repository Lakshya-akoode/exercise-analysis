# Live Pose Exercise Trainer

A React-based web application for real-time exercise guidance using MediaPipe pose detection. This application provides step-by-step exercise coaching with automatic pose validation and feedback.

## Exercise: "No Doming" Abdominal Stability with Leg Lift

This app guides you through a 2-step abdominal stability exercise with real-time pose validation.

## Features

- **Body Visibility Detection**: Ensures your full body is visible before starting
- **Real-time Pose Detection**: Uses MediaPipe to track your body pose
- **Step-by-Step Guidance**: Automatically progresses through exercise steps
- **Live Feedback**: Provides real-time feedback on your form
- **Voice Coach**: Voice announcements for step transitions and corrections (can be toggled on/off)
- **Pose Validation**: Validates angles for hip, knee, and leg position
- **Smooth Transitions**: Smoothed landmark detection for stable tracking
- **Clean Light UI**: Beautiful, minimalist interface with warm, professional colors

## Installation

```bash
cd frontend/pose-detection
npm install
```

**Note**: The MediaPipe WASM error has been fixed by:
- Removing React StrictMode (which causes double initialization)
- Adding initialization guards
- Using tilde (`~`) version constraints for exact package versions

## Running the Application

```bash
npm start
```

The application will open at [http://localhost:3000](http://localhost:3000)

## Usage

1. **Allow Camera Access**: When prompted, allow the browser to access your camera
2. **Position Yourself**: Step back until your entire body is visible
   - The app will show "Please Step Back" in orange if you're too close
   - Skeleton turns green when properly positioned
   - A progress bar will fill as the app confirms visibility
3. **Voice Prompts**: Listen for voice guidance:
   - "Please step back. Your full body needs to be visible." (if too close)
   - "Good! Let's start. Step 1..." (when ready)
4. **Exercise Guidance**: Follow the on-screen and voice instructions
5. **Live Feedback**: Corrections appear in an orange box at the bottom
6. **Toggle Voice**: Click "Voice On/Off" button to enable/disable voice feedback
7. **Restart**: Click "Restart Exercise" to start over

## Exercise Steps

1. **Lay on the back**: Laying on the back with the legs folded
2. **Lift the leg up**: Lifting the leg and holding it high

## How It Works

- **Visibility Check**: The app first verifies all key body points are visible (shoulders, hips, knees, ankles)
- **Color-Coded Skeleton**: 
  - Green = Body properly visible, exercise active
  - Orange = Body partially visible, move back
- **Pose Validation**: Uses angle calculations between key body points
- **Step Progression**: Requires maintaining correct pose for 10 consecutive frames
- **Smart Feedback**: Real-time corrections with 3-second cooldown to avoid repetition
- **Metrics Displayed**: Hip angle, knee angle, and leg height

## Visual States

1. **Positioning Phase** (Top and bottom overlay bars - camera remains visible):
   - "⚠️ Please Step Back" (orange text) - Move further from camera
   - "Great! Hold still..." (green text) - Proper distance, confirming visibility
   - Progress bar fills as system confirms all points visible
   - Camera feed visible in center so you can see yourself positioning

2. **Exercise Phase** (Light beige overlay at top):
   - Current and next step names
   - Real-time angle and position metrics
   - Progress indicator showing step completion

3. **Feedback** (Orange-bordered box at bottom):
   - Specific corrections needed
   - Spoken aloud if voice is enabled

## Technologies

- React 19.2
- MediaPipe Pose
- React Scripts
- Web Camera API

## Development

Built with Create React App. See package.json for available scripts.
