import type { ApiAddress } from '../../api/addresses';

export type LocationSelectorTheme = 'dark' | 'light' | 'auto';

export type Mode =
  | { kind: 'select'; initialAddressId?: string }
  | { kind: 'change-location' }
  | { kind: 'add-new' } // open straight into the add-a-new-address flow (pin step)
  | { kind: 'manage'; editAddress?: ApiAddress };

export interface LocationSelectorProps {
  visible: boolean;
  onClose: () => void;
  onLocationSelect: (
    name: string,
    lat: number,
    lon: number,
    addressId?: string,
    address?: ApiAddress,
  ) => void;
  onAddressesChanged?: () => void;
  mode: Mode;
  theme?: LocationSelectorTheme;
}

export type Step = 'search' | 'confirm-pin' | 'address-form';

export type AddressTag = 'Home' | 'Work' | 'Other';

export interface SelectedPlace {
  name: string;
  lat: number;
  lon: number;
}

export interface FormValues {
  tag: AddressTag;
  flatNo: string;
  floor: string;
  buildingName: string;
  landmark: string;
  receiverName: string;
  receiverPhone: string;
  setAsDefault: boolean;
}

export const INITIAL_FORM: FormValues = {
  tag: 'Home',
  flatNo: '',
  floor: '',
  buildingName: '',
  landmark: '',
  receiverName: '',
  receiverPhone: '',
  setAsDefault: true,
};

export const INDIAN_PHONE_REGEX = /^[6-9]\d{9}$/;
