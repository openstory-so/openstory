import { redirect } from "next/navigation";

export default async function HomePage() {
  // For now, all users go to create new sequence
  // In the future, we'll check if they have existing sequences
  // and redirect to /sequences if they do
  redirect("/sequences/new");
}
