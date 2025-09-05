import { generateFrameDescriptions } from "./src/lib/ai/frame-generator";
import { analyzeScriptForFrames } from "./src/lib/ai/script-analyzer";

const testScript = `# 30-Second YouTube Video Script

**Title:** "My Dog Taught Me This Life-Changing Productivity Hack!"

---

## Script Breakdown

### [0-3s] Hook
*(Playful tone, pet visible in background)*
"My golden retriever accidentally became my productivity coach, and it's genius!"

### [4-10s] Problem/Setup
*(Animated, gesturing to pet)*
"Dogs don't procrastinate - they see food bowl? They eat. They need to go out? They go. So I started copying them..."

### [11-20s] Solution/Examples
*(Quick pace, showing pet)*
"Any task under 2 minutes? DO IT NOW! Fill the water bowl, answer that text, pick up those toys. No thinking, just doing."
*(Points to growing completed list)*
"Look at this - 27 tiny tasks done today that used to pile up for WEEKS!"

### [21-27s] Transformation/Result
*(Calmer tone, petting dog)*
"My apartment's cleaner, inbox finally at zero, and that guilty 3am stress? Gone. All because I started thinking like my four-legged productivity guru here."

### [28-30s] Call-to-Action
*(Dog 'high-fives' with paw)*
"Try the 2-minute dog rule tomorrow - your future self (and your pet) will thank you!"`;

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
    });

    console.log("\n=== Frame Descriptions ===");
    frameDescriptions.frames.forEach((frame, i) => {
      console.log(`\nFrame ${i + 1}:`);
      console.log("Scene:", frame.metadata.scene);
      console.log("Shot type:", frame.metadata.shotType);
      console.log("Script chunk:", `${frame.description.substring(0, 100)}...`);
      console.log("Full chunk length:", frame.description.length);
    });
  } catch (error) {
    console.error("Error:", error);
  }
}

test();
