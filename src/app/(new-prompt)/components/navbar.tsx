import { ArrowIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";

export function Navbar() {
  return (
    <nav className="flex h-[70px] w-full items-center justify-between px-4 py-3 sm:h-[97px] sm:px-8 sm:py-4">
      <div className="flex items-center gap-2">
        <div className="relative font-medium tracking-[2.56px] text-white">
          <span className="text-[24px] leading-none sm:text-[32px]">VELRO</span>
          <span className="absolute -top-1 left-[90px] -translate-x-1/2 text-[10px] tracking-[-0.6px] text-white/90 [text-shadow:rgba(0,0,0,0.25)_0px_4px_4px] sm:left-[119px] sm:text-[12px] sm:tracking-[-0.72px]">
            ©
          </span>
        </div>
      </div>

      <div className="hidden h-[100px] w-[100px] sm:block" />

      <div className="flex items-center gap-2">
        <Button className="rounded-xl border border-[#f5f7fa] bg-transparent px-3 py-1.5 text-[14px] font-medium tracking-[-0.42px] text-white transition-colors hover:bg-white/10 sm:px-4 sm:py-2 sm:text-[16px] sm:tracking-[-0.48px]">
          Login
        </Button>
        <Button className="flex items-center gap-1 rounded-xl bg-white px-3 py-1.5 text-[14px] font-medium tracking-[-0.42px] text-black transition-colors hover:bg-white/90 sm:px-4 sm:py-2 sm:text-[16px] sm:tracking-[-0.48px]">
          <span>Get Started</span>
          <ArrowIcon size="sm" className="h-3 w-3 sm:h-4 sm:w-4" />
        </Button>
      </div>
    </nav>
  );
}
