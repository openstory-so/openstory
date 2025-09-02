"use client";

import { useRouter } from "next/navigation";
import * as React from "react";

export const CreatePage: React.FC = () => {
  const router = useRouter();

  React.useEffect(() => {
    // Redirect to homepage which now contains the create flow
    router.replace("/");
  }, [router]);

  return null;
};

export default CreatePage;
