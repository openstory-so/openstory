import { Navbar } from "@/app/(new-prompt)/components/navbar";
import { NewPromptInput } from "@/app/(new-prompt)/components/new-prompt-field";

export default function HomePage() {
  return (
    <div className="relative flex min-h-screen w-full flex-col items-start overflow-hidden">
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat rotate-180"
        style={{ backgroundImage: "url(/bg.png)" }}
      />

      <div className="absolute inset-0 bg-black/10" />

      <div className="relative z-10 flex w-full flex-col max-md:h-svh">
        <Navbar />

        <div className="flex w-full flex-col items-center px-4 pb-8 pt-8 sm:px-8 sm:pb-[61px] sm:pt-[50px]  max-md:justify-between max-md:h-full max-md:flex-1">
          <div className="mb-8 flex flex-col items-center text-center sm:mb-10">
            <h1 className="mb-3 h-auto w-full max-w-[90vw] bg-gradient-to-b from-white to-white/80 bg-clip-text font-heading text-[32px] font-medium leading-[110%] tracking-[-0.96px] text-transparent sm:mb-4 sm:w-[616px] sm:text-[58px] sm:tracking-[-1.74px]">
              What's on your mind
              <br />
              to make today?
            </h1>
            <p className="w-full max-w-[90vw] px-4 font-sans text-[14px] font-light leading-[140%] tracking-[-0.42px] text-[#f5f7fa] sm:w-[441px] sm:px-0 sm:text-[18px] sm:tracking-[-0.54px]">
              Unlock the creative inner director with a single conversation.
            </p>
          </div>

          <NewPromptInput />
        </div>
      </div>
    </div>
  );
}
