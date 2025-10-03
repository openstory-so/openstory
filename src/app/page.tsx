"use client";

import { useState } from "react";
import { BrainIcon } from "@/components/icons/brain";
import { ArrowIcon } from "@/components/icons/right-arrow-icon";
import { Button } from "@/components/ui/button";

export default function HomePage() {
  const [inputText, setInputText] = useState(
    "Wide shot from ground-level POV. West Texas desert landscape, 6PM golden hour ending, desaturated yellows and teals color grade, psychological thriller atmosphere. Rust-colored 1990s Chevrolet pickup truck emerges through heat shimmer distortion, headlights cutting through golden dusk. Man early 40s with faded blue work shirt rolled sleeves, worn jeans, brown cowboy boots, weathered cowboy hat, stubbled jaw, driving the truck. Young woman mid-20s with torn white tank top, khaki hiking shorts, brown hiking boots covered in red dust, long dark tangled dusty hair, sun-burned skin, lying on ground in foreground. Massive dust cloud trails vehicle.\n\nFincher's locked-off tripod composition, perfectly symmetrical with truck centered on horizon line. Viper FilmStream digital clarity showing every dust mote in volumetric lighting. Extreme depth of field from sharp foreground pebbles to sharp truck details 200 feet away. Color grade pushing warm tones to sickly yellow while shadows shift cyan.",
  );
  const [currentPhrase, _setCurrentPhrase] = useState(1);
  const totalPhrases = 3;

  return (
    <div className="relative flex min-h-screen w-full flex-col items-start overflow-hidden">
      {/* Background image */}
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat rotate-180"
        style={{ backgroundImage: "url(/bg.png)" }}
      />

      {/* Optional overlay for better text readability */}
      <div className="absolute inset-0 bg-black/10" />

      {/* Content wrapper */}
      <div className="relative z-10 flex w-full flex-col">
        {/* Navbar */}
        <nav className="flex h-[97px] w-full items-center justify-between px-8 py-4">
          {/* Logo */}
          <div className="flex items-center gap-2">
            <div className="relative font-medium tracking-[2.56px] text-white">
              <span className="text-[32px] leading-none">VELRO</span>
              <span className="absolute -top-1 left-[119px] -translate-x-1/2 text-[12px] tracking-[-0.72px] text-white/90 [text-shadow:rgba(0,0,0,0.25)_0px_4px_4px]">
                ©
              </span>
            </div>
          </div>

          {/* Spacer */}
          <div className="h-[100px] w-[100px]" />

          {/* Buttons */}
          <div className="flex items-center gap-2">
            <Button
              size="lg"
              className="rounded-lg border border-[#f5f7fa] px-4 py-2 text-[16px] font-medium tracking-[-0.48px] text-white transition-colors hover:bg-white/10"
            >
              Login
            </Button>
            <Button
              size="lg"
              className="flex items-center gap-1 rounded-lg bg-white px-4 py-2 text-[16px] font-medium tracking-[-0.48px] text-black transition-colors hover:bg-white/90"
            >
              <span> Get Started</span>
              <ArrowIcon size="sm" />
            </Button>
          </div>
        </nav>

        {/* Main Content */}
        <div className="flex w-full flex-col items-center px-8 pb-[61px] pt-[50px]">
          {/* Header */}
          <div className="mb-10 flex flex-col items-center text-center">
            <h1 className="mb-4 w-[616px] bg-gradient-to-b from-white to-white/80 bg-clip-text font-heading text-[58px] font-medium leading-[100%] tracking-[-1.74px] text-transparent">
              What's on your mind
              <br />
              to make today?
            </h1>
            <p className="w-[441px] font-sans text-[18px] font-light tracking-[-0.54px] text-[#f5f7fa]">
              Unlock the creative inner director with a single conversation.
            </p>
          </div>

          {/* Input Area */}
          <div className="w-full max-w-[708px]">
            <div className="relative rounded-2xl border border-[rgba(219,219,219,0.28)] bg-[rgba(74,74,74,0.22)] p-4 backdrop-blur-sm">
              <div className="flex h-[267px] flex-col">
                <textarea
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  className="mb-3 flex-1 resize-none bg-transparent text-[12px] font-medium italic tracking-[-0.36px] text-white outline-none placeholder:text-white/50 "
                  placeholder="Describe your scene..."
                />

                <div className="flex items-end justify-between border-t border-[rgba(103,103,103,0.22)] pt-3">
                  <div className="flex items-center py-1.5">
                    <span className="text-[12px] tracking-[-0.36px] text-[#b2b2b2]">
                      {currentPhrase} of {totalPhrases} phases
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button className="flex items-center gap-1.5  bg-[#ff4400] px-4 py-2 transition-colors hover:bg-[#ff4400]/90">
                      <BrainIcon className="fill-current text-white" />
                      <span className="text-[12px] tracking-[-0.36px] text-white">
                        Enhance
                      </span>
                    </Button>

                    <Button
                      type="button"
                      className="flex items-center justify-center transition-transform hover:scale-110 bg-white hover:bg-white/90"
                      aria-label="Submit"
                    >
                      <ArrowIcon direction="up" size="sm" />
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
