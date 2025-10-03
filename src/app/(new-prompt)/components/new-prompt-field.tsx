"use client";
import { useState } from "react";
import { EnhancingButton } from "@/app/(new-prompt)/components/enhancing-button";
import { ArrowIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";

export function NewPromptInput() {
  const [inputText, setInputText] = useState(
    "Wide shot from ground-level POV. West Texas desert landscape, 6PM golden hour ending, desaturated yellows and teals color grade, psychological thriller atmosphere. Rust-colored 1990s Chevrolet pickup truck emerges through heat shimmer distortion, headlights cutting through golden dusk. Man early 40s with faded blue work shirt rolled sleeves, worn jeans, brown cowboy boots, weathered cowboy hat, stubbled jaw, driving the truck. Young woman mid-20s with torn white tank top, khaki hiking shorts, brown hiking boots covered in red dust, long dark tangled dusty hair, sun-burned skin, lying on ground in foreground. Massive dust cloud trails vehicle.\n\nFincher's locked-off tripod composition, perfectly symmetrical with truck centered on horizon line. Viper FilmStream digital clarity showing every dust mote in volumetric lighting. Extreme depth of field from sharp foreground pebbles to sharp truck details 200 feet away. Color grade pushing warm tones to sickly yellow while shadows shift cyan.",
  );
  const [currentPhrase, _setCurrentPhrase] = useState(1);
  const totalPhrases = 3;

  const handleEnhance = async () => {
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const enhancedText = `Cinematic mastery at its finest. Camera positioned at exact ground level, lens kissing the desert floor. Golden hour transforms into blue hour - that magical 20-minute window where warm and cool tones battle for dominance. Every grain of sand rendered in 8K clarity, heat shimmer creating natural chromatic aberration at frame edges.\n\nThe Chevrolet emerges like a ghost from old America - rust patterns telling stories of decades under harsh sun. Headlight beams slice through suspended dust particles, each mote catching light like microscopic stars. Our driver's weathered hands grip steering wheel at perfect 10-and-2, wedding ring catching last rays of daylight.\n\nForeground woman positioned using rule of thirds, her dusty hair creating organic frame lines. Skin texture showing genuine sun damage - no makeup, pure documentary realism. Dust cloud behind truck creates natural depth separation, atmospheric perspective amplified by lens compression from 85mm focal length.\n\nColor science: Yellows desaturated to 60%, teals pushed +20 in shadows. Fincher's signature teal-orange look but pushed toward psychological discomfort. Shadows crushed to pure black in corners, vignette subtle but present.`;

        setInputText(enhancedText);
        resolve();
      }, 2000);
    });
  };

  return (
    <div className="w-full max-w-[calc(100vw-2rem)]  sm:max-w-[708px] ">
      <div className="relative rounded-xl border border-[rgba(219,219,219,0.28)] bg-[rgba(74,74,74,0.22)] p-3 backdrop-blur-sm sm:rounded-2xl sm:p-4">
        <div className="flex h-[220px] flex-col sm:h-[267px]">
          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            className="mb-3 flex-1 resize-none bg-transparent text-[11px] font-medium italic leading-[140%] tracking-[-0.33px] text-white outline-none placeholder:text-white/50 sm:text-[12px] sm:tracking-[-0.36px]"
            placeholder="Describe your scene..."
          />

          <div className="flex justify-between gap-2 border-t border-[rgba(103,103,103,0.22)] pt-3 ">
            <div className="flex items-center py-1">
              <span className="text-[11px] tracking-[-0.33px] text-[#b2b2b2] sm:text-[12px] sm:tracking-[-0.36px]">
                {currentPhrase} of {totalPhrases} phases
              </span>
            </div>

            <div className="flex items-center gap-2">
              <EnhancingButton
                resloveTo="success"
                onEnhance={handleEnhance}
                className=" bg-[#FF4400] px-3 py-2 text-[11px] font-normal tracking-[-0.33px] hover:bg-[#FF4400]/90 sm:flex-none sm:px-4 sm:text-[12px] sm:tracking-[-0.36px]"
              >
                Enhance
              </EnhancingButton>

              <Button
                type="button"
                className="flex  items-center justify-center bg-white transition-transform hover:scale-110 hover:bg-white/90 "
                aria-label="Submit"
              >
                <ArrowIcon direction="up" size="sm" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
