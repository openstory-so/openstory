import { createServerClient } from "./src/lib/supabase/server";

async function debugScriptAnalysis() {
  const supabase = createServerClient();
  const sequenceId = "1c25b136-9387-4b9b-a760-ddcab8d74c8e";

  // Get sequence
  const { data: sequence } = await supabase
    .from("sequences")
    .select("*")
    .eq("id", sequenceId)
    .single();

  if (!sequence || !sequence.script) {
    console.error("No sequence or script found");
    return;
  }

  const script = sequence.script;
  console.log("Script length:", script.length, "characters");

  // Let's simulate what the script analyzer should do
  // Split the script into roughly equal chunks for 3-5 frames
  const targetFrames = 3;
  const chunkSize = Math.ceil(script.length / targetFrames);

  console.log("\n=== Correct Script Division ===");
  console.log(
    `Should divide ${script.length} chars into ${targetFrames} frames`,
  );
  console.log(`Each frame should have ~${chunkSize} characters`);

  for (let i = 0; i < targetFrames; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, script.length);
    const chunk = script.slice(start, end);

    console.log(`\nFrame ${i + 1}:`);
    console.log(`  Position: ${start} - ${end}`);
    console.log(`  Length: ${chunk.length} chars`);
    console.log(`  Content: "${chunk.substring(0, 100)}..."`);
  }

  // Now let's see what's in the metadata
  const { data: job } = await supabase
    .from("jobs")
    .select("*")
    .eq("metadata->sequenceId", sequenceId)
    .eq("type", "frame_generation")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (job?.result) {
    console.log("\n=== Job Result ===");
    console.log(JSON.stringify(job.result, null, 2));
  }
}

debugScriptAnalysis().catch(console.error);
