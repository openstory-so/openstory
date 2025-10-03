import { Check, Loader, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import { BrainIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const useStatus = ({
  resloveTo,
  onEnhance,
}: {
  resloveTo: "success" | "error";
  onEnhance?: () => Promise<void> | void;
}) => {
  const [status, setStatus] = React.useState("idle");
  const onSubmit = async () => {
    setStatus("loading");
    try {
      if (onEnhance) {
        await onEnhance();
      }
      // Show success immediately after onEnhance completes
      setStatus(resloveTo);
      // Reset to idle after showing success
      setTimeout(() => {
        setStatus("idle");
      }, 1500);
    } catch (_error) {
      setStatus("error");
      setTimeout(() => {
        setStatus("idle");
      }, 1500);
    }
  };

  return {
    onSubmit,
    status,
  };
};

export const EnhancingButton: React.FC<
  React.ComponentPropsWithoutRef<"button"> & {
    resloveTo: "success" | "error";
    onEnhance?: () => Promise<void> | void;
  }
> = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<"button"> & {
    resloveTo: "success" | "error";
    onEnhance?: () => Promise<void> | void;
  }
>(({ children, className, onEnhance, resloveTo, ...props }, ref) => {
  const { status, onSubmit } = useStatus({ resloveTo, onEnhance });
  return (
    <Button
      ref={ref}
      disabled={status === "loading"}
      onClick={onSubmit}
      {...props}
      variant={status === "error" ? "destructive" : "default"}
      className={cn("w-32", className)}
    >
      <AnimatePresence mode="wait">
        {status === "idle" && (
          <>
            <motion.span
              key={crypto.randomUUID()}
              exit={{
                opacity: 0,
                x: 15,
                transition: { duration: 0.6, type: "spring" },
              }}
              style={{ display: "flex", alignItems: "center" }}
            >
              <BrainIcon className="fill-current text-white size-[15px]" />
            </motion.span>
            <motion.span
              key={crypto.randomUUID()}
              exit={{
                opacity: 0,
                transition: { duration: 0.6 },
              }}
              style={{ display: "flex", alignItems: "center" }}
            >
              {children}
            </motion.span>
          </>
        )}
        {status === "loading" && (
          <motion.span
            key={crypto.randomUUID()}
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 100, y: 0, transition: { delay: 0 } }}
            exit={{ opacity: 0, y: -15, transition: { duration: 0.3 } }}
          >
            <Loader className="animate-spin" size="19" />
          </motion.span>
        )}
        {["success", "error"].includes(status) && (
          <motion.span
            key={crypto.randomUUID()}
            initial={{ opacity: 0, y: 15, scale: 0 }}
            animate={{
              opacity: 100,
              y: 0,
              scale: 1,
              transition: { delay: 0.1, duration: 0.4 },
            }}
            exit={{ opacity: 0, y: -15, transition: { duration: 0.3 } }}
          >
            {status === "success" && <Check size="20" />}
            {status === "error" && <X size="20" />}
          </motion.span>
        )}
      </AnimatePresence>
    </Button>
  );
});

EnhancingButton.displayName = "EnhancingButton";
