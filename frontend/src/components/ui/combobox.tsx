import * as React from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { LinkFieldAction } from '@/components/ui/link-field-control';

export interface ComboboxOption {
  value: string;
  label: string;
  subtitle?: string;
  action?: () => void;
}

export interface ComboboxProps {
  /**
   * Rendered on the trigger so a sibling `<Label htmlFor>` actually resolves.
   * Without it every `<Label htmlFor="x"><Combobox/></Label>` pairing in the
   * app is a dangling association: clicking the label does nothing and
   * assistive tech cannot pair the two.
   */
  id?: string;
  options: ComboboxOption[];
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  emptyText?: string;
  searchPlaceholder?: string;
  linkTo?: (value: string) => string | undefined;
  onSearchChange?: (search: string) => void;
  shouldFilter?: boolean;
  className?: string;
}

export function Combobox({
  id,
  options,
  value,

  onValueChange,
  placeholder = 'Select option...',
  disabled = false,
  emptyText = 'No option found.',
  searchPlaceholder = 'Search...',
  linkTo,
  onSearchChange,
  shouldFilter,
  className,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);

  const selectedOption = options.find((option) => option.value === value);
  const href = value && linkTo ? linkTo(value) : undefined;
  const showLink = Boolean(href) && !disabled;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn('h-9 w-full justify-between bg-transparent px-3 py-2 font-normal', className)}
          disabled={disabled}
        >
          {selectedOption ? (
            <span className="min-w-0 flex-1 truncate text-left">{selectedOption.label}</span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">{placeholder}</span>
          )}
          <div className="flex shrink-0 items-center gap-0.5">
            {showLink && href ? <LinkFieldAction href={href} /> : null}
            <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
          </div>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command shouldFilter={shouldFilter}>
          <CommandInput placeholder={searchPlaceholder} onValueChange={onSearchChange} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  onSelect={() => {
                   if (option.action) {
                     option.action();
		     setOpen(false);
		     return;
                    }
                    onValueChange?.(option.value === value ? '' : option.value);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4',
                      value === option.value ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate">{option.label}</span>
                    {option.subtitle ? (
                      <span className="truncate text-xs text-muted-foreground">{option.subtitle}</span>
                    ) : null}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
