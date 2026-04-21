declare module 'react-native-razorpay' {
  export interface RazorpayOptions {
    description?: string;
    image?: string;
    currency: string;
    key: string;
    amount: string;
    name: string;
    order_id?: string;
    prefill?: {
      email?: string;
      contact?: string;
      name?: string;
    };
    notes?: Record<string, string>;
    theme?: {
      color?: string;
    };
  }

  export interface RazorpaySuccess {
    razorpay_order_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
  }

  export interface RazorpayFailure {
    code: number;
    description: string;
  }

  const RazorpayCheckout: {
    open: (options: RazorpayOptions) => Promise<RazorpaySuccess>;
  };

  export default RazorpayCheckout;
}
