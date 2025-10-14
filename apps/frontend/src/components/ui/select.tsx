import type React from "react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange"> {
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
  size?: "sm" | "md" | "lg";
  variant?: "default" | "outline" | "ghost";
}

export const Select: React.FC<SelectProps> = ({
  className,
  options,
  value,
  defaultValue,
  placeholder = "Select an option...",
  disabled = false,
  onChange,
  size = "md",
  variant = "default",
  ...props
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const isControlled = value !== undefined;
  const [internalValue, setInternalValue] = useState(defaultValue || "");
  const selectedValue = isControlled ? (value as string) : internalValue;
  const containerRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);

  const selectedOption = options.find(
    (option) => option.value === selectedValue,
  );

  const handleSelect = (optionValue: string) => {
    if (disabled) return;
    if (!isControlled) setInternalValue(optionValue);
    onChange?.(optionValue);
    setIsOpen(false);
  };

  const sizeClasses = {
    sm: "h-8 px-2 text-sm",
    md: "h-10 px-3 text-sm",
    lg: "h-12 px-4 text-base",
  };

  const variantClasses = {
    default: "bg-background border border-input",
    outline: "bg-transparent border-2 border-input",
    ghost: "bg-transparent border-none hover:bg-accent",
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setIsOpen(true);
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        let nextIndex = focusedIndex + 1;
        while (nextIndex < options.length && options[nextIndex].disabled) {
          nextIndex++;
        }
        setFocusedIndex(Math.min(nextIndex, options.length - 1));
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        let prevIndex = focusedIndex - 1;
        while (prevIndex >= 0 && options[prevIndex].disabled) {
          prevIndex--;
        }
        setFocusedIndex(Math.max(prevIndex, 0));
        break;
      }
      case "Enter":
        e.preventDefault();
        if (focusedIndex >= 0 && !options[focusedIndex].disabled) {
          handleSelect(options[focusedIndex].value);
        }
        break;
      case "Escape":
        e.preventDefault();
        setIsOpen(false);
        break;
    }
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  return (
    <div
      className={cn("relative inline-block w-full", className)}
      {...props}
      ref={containerRef}
    >
      <button
        type="button"
        className={cn(
          "flex w-full items-center justify-between rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
          sizeClasses[size],
          variantClasses[variant],
          {
            "cursor-not-allowed opacity-50": disabled,
            "hover:bg-accent hover:text-accent-foreground":
              !disabled && variant !== "ghost",
          },
        )}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        aria-expanded={isOpen}
        aria-controls={isOpen ? "select-options" : undefined}
      >
        <span
          className={cn("truncate", !selectedOption && "text-muted-foreground")}
        >
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <svg
          className={cn("h-4 w-4 transition-transform", isOpen && "rotate-180")}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <title>Toggle dropdown</title>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {isOpen && (
        <div
          role="listbox"
          id="select-options"
          aria-activedescendant={
            focusedIndex >= 0 ? `option-${focusedIndex}` : undefined
          }
          className="absolute z-50 mt-1 w-full min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          tabIndex={0}
          aria-label="Select options"
        >
          {options.map((option, index) => (
            <button
              type="button"
              key={option.value}
              id={`option-${index}`}
              role="option"
              aria-selected={selectedValue === option.value}
              className={cn(
                "flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground",
                {
                  "bg-accent text-accent-foreground":
                    selectedValue === option.value,
                  "cursor-not-allowed opacity-50": option.disabled,
                },
              )}
              onClick={() => !option.disabled && handleSelect(option.value)}
              disabled={option.disabled}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
