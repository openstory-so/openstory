import { generateFrameDescriptions } from "./src/lib/ai/frame-generator";
import { analyzeScriptForFrames } from "./src/lib/ai/script-analyzer";

const testScript = `**Title:** "My Dog Taught Me This Life-Changing Productivity Hack!"

---

## Script Breakdown

### [0-10s] Hook
*(Playful tone, pet visible in background)*
"My golden retriever accidentally became my productivity coach, and it's genius!"

### [10-25s] Problem/Setup
*(Animated, gesturing to pets)*
"Dogs aren't procrastinators. They see food bowl? They eat. They need to go out? They go. So I started copying them..."

### [25-35s] Solution/Example
*(Quick pace, showing pet interactions)*
"Any task under 2 minutes? DO IT NOW! Fill the water bowl, answer that text, pick up those toys. No thinking, just doing like my furry friend here!"`;

async function test() {
  console.log("Testing script analyzer with script length:", testScript.length);

  try {
    // First analyze the script
    const analysis = await analyzeScriptForFrames(testScript);
    console.log("\n=== Script Analysis ===");
    console.log(JSON.stringify(analysis, null, 2));

    // Now generate frames
    const frameDescriptions = await generateFrameDescriptions({
      scriptAnalysis: analysis,
      framesPerScene: 1, // One frame per scene for testing
    });

    console.log("\n=== Frame Descriptions ===");
    frameDescriptions.frames.forEach((frame, i) => {
      console.log(`\nFrame ${i + 1}:`);
      console.log(
        "Script positions:",
        frame.metadata.scriptStart,
        "-",
        frame.metadata.scriptEnd,
      );
      console.log("Script chunk:", `${frame.description.substring(0, 100)}...`);
      console.log("Full chunk length:", frame.description.length);
    });
  } catch (error) {
    console.error("Error:", error);
  }
}

test();
