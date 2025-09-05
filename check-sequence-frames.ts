import { createServerClient } from "./src/lib/supabase/server";

async function checkSequenceFrames() {
  const supabase = createServerClient();
  const sequenceId = "1c25b136-9387-4b9b-a760-ddcab8d74c8e";

  // Get sequence
  const { data: sequence, error: seqError } = await supabase
    .from("sequences")
    .select("*")
    .eq("id", sequenceId)
    .single();

  if (seqError) {
    console.error("Error fetching sequence:", seqError);
    return;
  }

  console.log("=== Sequence ===");
  console.log("ID:", sequence.id);
  console.log("Title:", sequence.title);
  console.log("Script length:", sequence.script?.length || 0);
  console.log("Script preview:", `${sequence.script?.substring(0, 200)}...`);

  // Get frames
  const { data: frames, error: framesError } = await supabase
    .from("frames")
    .select("*")
    .eq("sequence_id", sequenceId)
    .order("order_index", { ascending: true });

  if (framesError) {
    console.error("Error fetching frames:", framesError);
    return;
  }

  console.log("\n=== Frames ===");
  console.log("Total frames:", frames.length);

  frames.forEach((frame, index) => {
    console.log(
      `\n--- Frame ${index + 1} (order_index: ${frame.order_index}) ---`,
    );
    console.log("ID:", frame.id);
    console.log("Description length:", frame.description?.length || 0);
    console.log(
      "Description preview:",
      `${frame.description?.substring(0, 100)}...`,
    );

    const metadata = frame.metadata as Record<string, unknown>;
    if (metadata) {
      const scriptChunk = metadata.scriptChunk as string | undefined;
      console.log("Metadata scene:", metadata.scene);
      console.log("Metadata shotType:", metadata.shotType);
      console.log("Metadata scriptChunk length:", scriptChunk?.length || 0);
      console.log(
        "Metadata scriptChunk preview:",
        `${scriptChunk?.substring(0, 100)}...`,
      );
    }
  });
}

checkSequenceFrames().catch(console.error);
